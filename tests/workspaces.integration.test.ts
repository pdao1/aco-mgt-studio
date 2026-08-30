import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../server/database/migrate.js';
import { Repository } from '../server/database/repository.js';
import { hashPassword, verifyPassword } from '../server/security/password.js';
import { THEME_IDS } from '../src/lib/themes.js';

const databaseUrl = process.env.ACO_TEST_DATABASE_URL;
// Run against a disposable database only; never migrate or seed a user's database.
describe.skipIf(!databaseUrl)('workspace persistence and isolation (PostgreSQL)', () => {
  let repo: Repository;
  let first: string;
  let second: string;
  let originalHash: string;
  const firstSlug = `first-${randomUUID()}`;
  const secondSlug = `second-${randomUUID()}`;
  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.startsWith('/aco_test_')) throw new Error('Use an aco_test_ disposable database.');
    await runMigrations(databaseUrl!);
    repo = new Repository(databaseUrl!);
    originalHash = await hashPassword('first-company-password');
    first = await repo.createWorkspace(firstSlug, 'First Company', originalHash);
    second = await repo.createWorkspace(secondSlug, 'Second Company', await hashPassword('second-company-password'));
  });
  afterAll(async () => { await repo?.close(); });

  it('isolates credentials and rejects claiming an existing slug', async () => {
    expect((await repo.credentialsForSlug(firstSlug))?.workspaceId).toBe(first);
    expect(await verifyPassword('first-company-password', (await repo.getCredentials(second))!.password_hash)).toBe(false);
    await expect(repo.createWorkspace(firstSlug, 'Impostor', originalHash)).rejects.toMatchObject({ code: '23505' });
  });

  it('persists all eight themes and preserves omitted payment settings', async () => {
    await repo.updateWorkspaceSettings(first, { notificationSellerEmail: 'seller@example.com', venmoPaymentUrl: 'https://venmo.com/example' });
    for (const theme of THEME_IDS) {
      await repo.updateWorkspaceSettings(first, { theme, displayName: 'Renamed Company' });
      expect(await repo.getWorkspaceSettings(first)).toMatchObject({ theme, displayName: 'Renamed Company', notificationSellerEmail: 'seller@example.com', venmoPaymentUrl: 'https://venmo.com/example' });
    }
    expect(await repo.getWorkspaceSettings(second)).toMatchObject({ displayName: 'Second Company', theme: 'classic-light', notificationSellerEmail: null });
    expect((await repo.dashboard(first)).workspace.name).toBe('Renamed Company');
  });

  it('keeps saved names and passwords across legacy bootstrap and rejects stale password changes', async () => {
    const newHash = await hashPassword('replacement-password');
    expect(await repo.changePassword(first, originalHash, newHash)).toBe(1);
    expect(await repo.changePassword(first, originalHash, newHash)).toBeNull();
    await repo.bootstrapPassword(first, originalHash);
    await repo.ensureWorkspace(firstSlug, 'Old ENV Name');
    expect((await repo.getCredentials(first))?.password_hash).toBe(newHash);
    expect((await repo.dashboard(first)).workspace.name).toBe('Renamed Company');
  });

  it('brands customer portals and drafts while preserving issued invoice identity', async () => {
    const customer = randomUUID(); const order = randomUUID();
    const client = await repo.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [first]);
      await client.query('INSERT INTO customers(id, workspace_id, display_name, gmail_address) VALUES ($1,$2,$3,$4)', [customer, first, 'Test Customer', 'customer@example.com']);
      await client.query(`INSERT INTO orders(id, workspace_id, customer_id, merchant, order_number, ordered_at, total_cents, fee_basis_points, status, source_message_key)
        VALUES ($1,$2,$3,'Test Store','TEST-123',now(),10000,1000,'confirmed','qa-message')`, [order, first, customer]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    const draft = await repo.createInvoice(first, customer, [order], 7, randomUUID());
    expect(draft.companyName).toBe('Renamed Company');
    expect(await repo.getInvoice(second, draft.id)).toBeNull();
    await repo.updateWorkspaceSettings(first, { displayName: 'Updated Before Issue' });
    expect((await repo.getInvoice(first, draft.id))?.companyName).toBe('Updated Before Issue');
    await repo.updateInvoiceStripeState(first, draft.id, { status: 'open', companyName: 'Updated Before Issue' });
    await repo.updateWorkspaceSettings(first, { displayName: 'Current Company' });
    const portal = await repo.customerPortal(first, customer);
    expect(portal?.workspace.settings.displayName).toBe('Current Company');
    expect(portal?.invoices[0].companyName).toBe('Updated Before Issue');
    expect(JSON.stringify(portal)).not.toContain('password_hash');
  });

  it('does not reactivate suspended companies during bootstrap', async () => {
    await repo.pool.query("UPDATE workspaces SET status = 'suspended' WHERE id = $1", [second]);
    await repo.ensureWorkspace(secondSlug, 'Old name');
    expect(await repo.credentialsForSlug(secondSlug)).toBeNull();
    expect(await repo.getCredentials(second)).toBeNull();
  });
});
