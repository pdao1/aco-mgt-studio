import type { PoolClient } from 'pg';
import type { Repository } from '../database/repository.js';
import { SoloRepository, serialHash, type SoloAccount } from '../solo/repository.js';
import type { DiscordIdentity } from '../solo/discord.js';
import type { VerifiedLicense } from '../billing/whop-membership.js';

export class LinkError extends Error {}
export interface LinkedService {
  workspaceId: string; product: 'solo' | 'aco'; path: string; version: number; solo?: SoloAccount;
}

export async function bindDiscord(client: PoolClient, identity: DiscordIdentity, workspaceId: string, makeDefault = true) {
  await client.query(`INSERT INTO discord_identities(discord_id,username) VALUES($1,$2)
    ON CONFLICT(discord_id) DO UPDATE SET username=EXCLUDED.username`, [identity.id, identity.username]);
  const result = await client.query(`INSERT INTO discord_bindings(workspace_id,discord_id) VALUES($1,$2)
    ON CONFLICT(workspace_id) DO UPDATE SET discord_id=EXCLUDED.discord_id
    WHERE discord_bindings.discord_id=EXCLUDED.discord_id RETURNING workspace_id`, [workspaceId, identity.id]);
  if (!result.rowCount) throw new LinkError('This service is already linked to another Discord account. Contact the service owner.');
  await client.query(`UPDATE discord_identities SET default_workspace_id=$2
    WHERE discord_id=$1 AND ($3 OR default_workspace_id IS NULL)`, [identity.id, workspaceId, makeDefault]);
}

export class IdentityRepository {
  constructor(private readonly core: Repository) {}

  async resolve(discordId: string, workspaceId?: string): Promise<LinkedService | null> {
    const result = await this.core.pool.query<{id:string;slug:string;product_type:'solo'|'aco'}>(`
      SELECT w.id,w.slug,w.product_type FROM discord_identities i
      JOIN discord_bindings b ON b.discord_id=i.discord_id AND b.workspace_id=COALESCE($2::uuid,i.default_workspace_id)
      JOIN workspaces w ON w.id=b.workspace_id WHERE i.discord_id=$1 AND workspace_has_access(w.id)
      AND (w.product_type='solo' OR EXISTS (SELECT 1 FROM whop_memberships m WHERE m.workspace_id=w.id
        AND m.product_type='aco' AND m.valid AND NOT m.access_suspended AND m.access_until>now() AND m.license_hash IS NOT NULL))`, [discordId, workspaceId ?? null]);
    const workspace = result.rows[0];
    if (!workspace) return null;
    if (workspace.product_type === 'solo') {
      const solo = await new SoloRepository(this.core).byDiscord(discordId);
      if (!solo || solo.workspaceId !== workspace.id) return null;
      return {workspaceId:workspace.id,product:'solo',path:`/customer/${solo.handle}`,version:solo.sessionVersion,solo};
    }
    const credentials = await this.core.getCredentials(workspace.id);
    return credentials ? {workspaceId:workspace.id,product:'aco',path:`/app/workspaces/${workspace.slug}`,version:credentials.session_version} : null;
  }

  async linkSolo(identity: DiscordIdentity, serial: string) {
    return this.transaction(async client => {
      const result = await client.query<{workspace_id:string;discord_id:string|null}>(`SELECT a.workspace_id,a.discord_id
        FROM solo_accounts a WHERE a.serial_hash=$1 AND a.access_expires_at>now() AND workspace_has_access(a.workspace_id) FOR UPDATE`, [serialHash(serial)]);
      const account = result.rows[0];
      if (!account) throw new LinkError('That serial is invalid, expired, or suspended.');
      if (account.discord_id && account.discord_id !== identity.id) throw new LinkError('That serial is already linked to another Discord account.');
      const other = await client.query('SELECT id FROM solo_accounts WHERE discord_id=$1 AND workspace_id<>$2', [identity.id, account.workspace_id]);
      if (other.rowCount) throw new LinkError('This Discord account already has a Solo Buyer service.');
      await bindDiscord(client, identity, account.workspace_id);
      // Preserve the customer's existing handle; routing is derived from the account.
      await client.query('UPDATE solo_accounts SET discord_id=$1,updated_at=now() WHERE workspace_id=$2', [identity.id, account.workspace_id]);
    });
  }

  async linkExistingSolo(identity: DiscordIdentity, workspaceId: string) {
    return this.transaction(async client => {
      const result = await client.query<{workspace_id:string;discord_id:string|null}>(`SELECT a.workspace_id,a.discord_id
        FROM solo_accounts a JOIN workspaces w ON w.id=a.workspace_id
        WHERE a.workspace_id=$1 AND a.access_expires_at>now() AND workspace_has_access(a.workspace_id) AND w.product_type='solo' FOR UPDATE`, [workspaceId]);
      const account = result.rows[0];
      if (!account) throw new LinkError('That Solo Buyer service is invalid, expired, or suspended.');
      if (account.discord_id && account.discord_id !== identity.id) throw new LinkError('That Solo service is already linked to another Discord account.');
      const other = await client.query('SELECT id FROM solo_accounts WHERE discord_id=$1 AND workspace_id<>$2', [identity.id, workspaceId]);
      if (other.rowCount) throw new LinkError('This Discord account already has a Solo Buyer service.');
      await bindDiscord(client, identity, workspaceId);
      await client.query('UPDATE solo_accounts SET discord_id=$1,updated_at=now() WHERE workspace_id=$2', [identity.id, workspaceId]);
    });
  }

  async linkLicense(identity: DiscordIdentity, license: VerifiedLicense) {
    await this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(731240191)');
      const current=await client.query(`SELECT id FROM whop_memberships WHERE id=$1 AND workspace_id=$2
        AND product_type=$3 AND license_hash=$4 AND valid AND NOT access_suspended AND access_until>now() AND workspace_has_access(workspace_id) FOR UPDATE`,
      [license.membershipId,license.workspaceId,license.product,license.licenseHash]);
      if(!current.rowCount)throw new LinkError('The license expired or changed. Enter your serial again.');
      if(license.product==='solo'){
        const other=await client.query('SELECT id FROM solo_accounts WHERE discord_id=$1 AND workspace_id<>$2',[identity.id,license.workspaceId]);
        if(other.rowCount)throw new LinkError('This Discord account already has an Individual service.');
      }
      await bindDiscord(client,identity,license.workspaceId);
      await client.query('UPDATE whop_memberships SET discord_id=$2 WHERE id=$1',[license.membershipId,identity.id]);
      if(license.product==='solo')await client.query('UPDATE solo_accounts SET discord_id=$2 WHERE workspace_id=$1',[license.workspaceId,identity.id]);
    });
  }

  private async transaction(work: (client: PoolClient) => Promise<void>) {
    const client = await this.core.pool.connect();
    try { await client.query('BEGIN'); await work(client); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
