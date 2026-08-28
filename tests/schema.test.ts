import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('PostgreSQL tenant and privacy schema', () => {
  it('forces workspace RLS on every customer-owned table', async () => {
    const sql = await readFile(new URL('../server/database/migrations/001_initial.sql', import.meta.url), 'utf8');
    const tables = [
      'customers', 'customer_mailboxes', 'orders', 'shipments',
      'order_events', 'processed_messages', 'sync_runs',
    ];
    for (const table of tables) {
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ON ${table}`);
    }
  });

  it('stores an encrypted mailbox envelope and no raw email body column', async () => {
    const sql = await readFile(new URL('../server/database/migrations/001_initial.sql', import.meta.url), 'utf8');
    expect(sql).toContain('secret_ciphertext text NOT NULL');
    expect(sql).not.toMatch(/raw_(?:email|body|message)/i);
  });

  it('keeps per-order fees bounded and integer-based', async () => {
    const sql = await readFile(new URL('../server/database/migrations/002_fees_portal.sql', import.meta.url), 'utf8');
    expect(sql).toContain('fee_basis_points integer NOT NULL DEFAULT 0');
    expect(sql).toContain('fee_basis_points BETWEEN 0 AND 10000');
  });

  it('protects billing snapshots, overrides, and Stripe event deduplication', async () => {
    const sql = await readFile(new URL('../server/database/migrations/003_billing_overrides.sql', import.meta.url), 'utf8');
    for (const table of ['invoices', 'invoice_lines', 'stripe_events']) {
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ON ${table}`);
    }
    expect(sql).toContain('idempotency_key text NOT NULL');
    expect(sql).toContain('UNIQUE (workspace_id, idempotency_key)');
    expect(sql).toContain('status_override text');
    expect(sql).toContain('orders_billing_invoice_fk');
  });

  it('models fee-only billing with checkout or custom fee bases', async () => {
    const sql = await readFile(new URL('../server/database/migrations/004_service_fee_tenancy.sql', import.meta.url), 'utf8');
    expect(sql).toContain("fee_basis IN ('checkout_total', 'custom_amount')");
    expect(sql).toContain('custom_fee_basis_cents integer');
    expect(sql).toContain("billing_model = 'service_fee_only' AND total_cents = fee_cents");
    expect(sql).toContain("WHERE status = 'draft'");
    expect(sql).toContain('fee_basis_cents integer');
  });

  it('adds idempotent provider-neutral workspace provisioning records', async () => {
    const sql = await readFile(new URL('../server/database/migrations/004_service_fee_tenancy.sql', import.meta.url), 'utf8');
    expect(sql).toContain("status IN ('provisioning', 'active', 'suspended')");
    expect(sql).toContain('node_group_key text');
    expect(sql).toContain('UNIQUE (provider, external_entitlement_id)');
    expect(sql).toContain('UNIQUE (provider, external_event_id)');
    for (const table of ['workspace_entitlements', 'workspace_memberships', 'workspace_provisioning_events']) {
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ON ${table}`);
    }
  });

  it('keeps static portal credentials encrypted and scopes branding to a workspace', async () => {
    const sql = await readFile(new URL('../server/database/migrations/005_beta_access_settings.sql', import.meta.url), 'utf8');
    expect(sql).toContain('portal_token_hash text');
    expect(sql).toContain('portal_token_ciphertext text');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS workspace_settings');
    expect(sql).toContain('ALTER TABLE workspace_settings FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain("venmo_payment_url text");
  });
});
