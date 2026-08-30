import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Repository } from '../database/repository.js';

export interface SoloAccount {
  id: string; workspaceId: string; handle: string; discordId: string | null;
  displayName: string; accessExpiresAt: string; mailboxLimit: number; sessionVersion: number;
}

type AccountRow = {
  id: string; workspace_id: string; handle: string; discord_id: string | null;
  display_name: string; access_expires_at: Date; mailbox_limit: number; session_version: number;
};
const columns = 'a.id, a.workspace_id, a.handle, a.discord_id, a.display_name, a.access_expires_at, a.mailbox_limit, a.session_version';
function map(row: AccountRow): SoloAccount {
  return { id: row.id, workspaceId: row.workspace_id, handle: row.handle, discordId: row.discord_id,
    displayName: row.display_name, accessExpiresAt: row.access_expires_at.toISOString(), mailboxLimit: row.mailbox_limit, sessionVersion: row.session_version };
}
export function serialHash(serial: string): string { return createHash('sha256').update(serial.trim()).digest('hex'); }

export class SoloRepository {
  constructor(private readonly core: Repository) {}

  async provision(input: { handle: string; displayName: string; discordId: string | null; days: number; mailboxLimit: number }) {
    const id = randomUUID(), workspaceId = randomUUID();
    const serial = `solo_${randomBytes(32).toString('base64url')}`;
    const client = await this.core.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      await client.query(`INSERT INTO workspaces(id, slug, name, node_group_key, status, product_type)
        VALUES ($1,$2,$3,$2,'active','solo')`, [workspaceId, `solo-${id}`, input.displayName]);
      await client.query(`INSERT INTO workspace_settings(workspace_id, display_name) VALUES($1,$2)`, [workspaceId, input.displayName]);
      await client.query(`INSERT INTO solo_accounts(id, workspace_id, handle, discord_id, display_name, serial_hash, access_expires_at, mailbox_limit)
        VALUES ($1,$2,$3,$4,$5,$6,now()+($7 * interval '1 day'),$8)`,
      [id, workspaceId, input.handle, input.discordId, input.displayName, serialHash(serial), input.days, input.mailboxLimit]);
      await client.query('COMMIT');
      return { id, serial, path: `/customer/${input.handle}` };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async find(field: 'id' | 'serial_hash' | 'discord_id', value: string): Promise<SoloAccount | null> {
    const result = await this.core.pool.query<AccountRow>(`SELECT ${columns} FROM solo_accounts a
      JOIN workspaces w ON w.id = a.workspace_id
      WHERE a.${field} = $1 AND a.access_expires_at > now() AND w.status = 'active' AND w.product_type = 'solo'`, [value]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  byId(id: string) { return this.find('id', id); }
  bySerial(serial: string) { return this.find('serial_hash', serialHash(serial)); }
  byDiscord(discordId: string) { return this.find('discord_id', discordId); }

  async linkDiscord(account: SoloAccount, discordId: string, username: string) {
    // Never transfer another Discord identity or merge two accounts by display name.
    const safeHandle = username.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64);
    const handle = /^[a-z0-9][a-z0-9._-]{1,63}$/.test(safeHandle) ? safeHandle : `discord-${discordId}`;
    const result = await this.core.pool.query(`UPDATE solo_accounts a SET discord_id = $2,
      handle = CASE WHEN NOT EXISTS(SELECT 1 FROM solo_accounts other WHERE other.handle=$3 AND other.id<>$1) THEN $3 ELSE a.handle END,
      updated_at = now()
      WHERE id = $1 AND (discord_id IS NULL OR discord_id = $2) AND session_version = $4 RETURNING id`,
    [account.id, discordId, handle, account.sessionVersion]);
    if (!result.rowCount) throw new Error('This account is already linked to another Discord user.');
    return this.byId(account.id);
  }

  async rotateSerial(handle: string) {
    const serial = `solo_${randomBytes(32).toString('base64url')}`;
    const result = await this.core.pool.query(`UPDATE solo_accounts SET serial_hash=$2,
      session_version=session_version+1, updated_at=now() WHERE handle=$1 RETURNING id`, [handle, serialHash(serial)]);
    if (!result.rowCount) throw new Error('Solo Buyer account not found.');
    return serial;
  }

  async renewAccess(handle: string, days: number) {
    const result = await this.core.pool.query<{access_expires_at: Date}>(`UPDATE solo_accounts
      SET access_expires_at=GREATEST(access_expires_at,now())+($2 * interval '1 day'), updated_at=now()
      WHERE handle=$1 RETURNING access_expires_at`, [handle, days]);
    if (!result.rows[0]) throw new Error('Solo Buyer account not found.');
    return result.rows[0].access_expires_at.toISOString();
  }
}
