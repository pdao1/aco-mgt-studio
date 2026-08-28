ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS node_group_key text,
  ADD COLUMN IF NOT EXISTS provisioning_provider text,
  ADD COLUMN IF NOT EXISTS external_owner_id text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE workspaces
SET node_group_key = slug
WHERE node_group_key IS NULL;

ALTER TABLE workspaces
  ALTER COLUMN node_group_key SET NOT NULL;

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_status_check,
  DROP CONSTRAINT IF EXISTS workspaces_provisioning_identity_check,
  DROP CONSTRAINT IF EXISTS workspaces_node_group_key_key;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_status_check
    CHECK (status IN ('provisioning', 'active', 'suspended')),
  ADD CONSTRAINT workspaces_provisioning_identity_check
    CHECK (
      (provisioning_provider IS NULL AND external_owner_id IS NULL)
      OR
      (provisioning_provider IS NOT NULL AND external_owner_id IS NOT NULL)
    ),
  ADD CONSTRAINT workspaces_node_group_key_key UNIQUE (node_group_key);

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_provider_owner_idx
  ON workspaces(provisioning_provider, external_owner_id)
  WHERE provisioning_provider IS NOT NULL AND external_owner_id IS NOT NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fee_basis text NOT NULL DEFAULT 'checkout_total',
  ADD COLUMN IF NOT EXISTS custom_fee_basis_cents integer;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_fee_basis_check,
  DROP CONSTRAINT IF EXISTS orders_custom_fee_basis_cents_check,
  DROP CONSTRAINT IF EXISTS orders_fee_basis_shape_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_fee_basis_check
    CHECK (fee_basis IN ('checkout_total', 'custom_amount')),
  ADD CONSTRAINT orders_custom_fee_basis_cents_check
    CHECK (custom_fee_basis_cents IS NULL OR custom_fee_basis_cents >= 0),
  ADD CONSTRAINT orders_fee_basis_shape_check
    CHECK (
      (fee_basis = 'checkout_total' AND custom_fee_basis_cents IS NULL)
      OR
      (fee_basis = 'custom_amount' AND custom_fee_basis_cents IS NOT NULL)
    );

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS billing_model text NOT NULL DEFAULT 'legacy_order_plus_fee';

ALTER TABLE invoice_lines
  ADD COLUMN IF NOT EXISTS billing_model text NOT NULL DEFAULT 'legacy_order_plus_fee',
  ADD COLUMN IF NOT EXISTS fee_basis text NOT NULL DEFAULT 'checkout_total',
  ADD COLUMN IF NOT EXISTS fee_basis_cents integer;

UPDATE invoice_lines
SET fee_basis_cents = subtotal_cents
WHERE fee_basis_cents IS NULL;

ALTER TABLE invoice_lines
  ALTER COLUMN fee_basis_cents SET NOT NULL;

-- Migration 003 used unnamed table checks, which PostgreSQL names
-- invoices_check and invoice_lines_check. Remove both those legacy names and
-- the explicit names used by repeatable development runs before converting
-- draft totals.
ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_check,
  DROP CONSTRAINT IF EXISTS invoices_total_cents_check,
  DROP CONSTRAINT IF EXISTS invoices_billing_model_check;

ALTER TABLE invoice_lines
  DROP CONSTRAINT IF EXISTS invoice_lines_check,
  DROP CONSTRAINT IF EXISTS invoice_lines_total_cents_check,
  DROP CONSTRAINT IF EXISTS invoice_lines_billing_model_check,
  DROP CONSTRAINT IF EXISTS invoice_lines_fee_basis_check,
  DROP CONSTRAINT IF EXISTS invoice_lines_fee_basis_cents_check;

-- Drafts have not been issued, so they are the only legacy snapshots that can
-- be safely converted to service-fee-only billing during deployment.
UPDATE invoice_lines AS line
SET billing_model = 'service_fee_only',
    total_cents = line.fee_cents
FROM invoices AS invoice
WHERE invoice.id = line.invoice_id
  AND invoice.workspace_id = line.workspace_id
  AND invoice.status = 'draft';

UPDATE invoices
SET billing_model = 'service_fee_only',
    total_cents = fee_cents,
    updated_at = now()
WHERE status = 'draft';

ALTER TABLE invoices
  ADD CONSTRAINT invoices_billing_model_check
    CHECK (billing_model IN ('legacy_order_plus_fee', 'service_fee_only')),
  ADD CONSTRAINT invoices_total_cents_check
    CHECK (
      (billing_model = 'legacy_order_plus_fee' AND total_cents = subtotal_cents + fee_cents)
      OR
      (billing_model = 'service_fee_only' AND total_cents = fee_cents)
    );

ALTER TABLE invoice_lines
  ADD CONSTRAINT invoice_lines_billing_model_check
    CHECK (billing_model IN ('legacy_order_plus_fee', 'service_fee_only')),
  ADD CONSTRAINT invoice_lines_fee_basis_check
    CHECK (fee_basis IN ('checkout_total', 'custom_amount')),
  ADD CONSTRAINT invoice_lines_fee_basis_cents_check
    CHECK (fee_basis_cents >= 0),
  ADD CONSTRAINT invoice_lines_total_cents_check
    CHECK (
      (billing_model = 'legacy_order_plus_fee' AND total_cents = subtotal_cents + fee_cents)
      OR
      (billing_model = 'service_fee_only' AND total_cents = fee_cents)
    );

ALTER TABLE invoices ALTER COLUMN billing_model SET DEFAULT 'service_fee_only';
ALTER TABLE invoice_lines ALTER COLUMN billing_model SET DEFAULT 'service_fee_only';

-- An order's billing pointer must never reference another workspace/customer.
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_billing_invoice_fk;

ALTER TABLE orders
  ADD CONSTRAINT orders_billing_invoice_fk
  FOREIGN KEY (workspace_id, customer_id, billing_invoice_id)
  REFERENCES invoices(workspace_id, customer_id, id)
  ON DELETE SET NULL (billing_invoice_id);

CREATE TABLE IF NOT EXISTS workspace_entitlements (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_entitlement_id text NOT NULL,
  plan_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'past_due', 'suspended', 'cancelled')),
  provider_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_entitlement_id),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'operator')),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, external_user_id),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS workspace_provisioning_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('received', 'processed', 'failed')),
  failure_code text,
  provider_occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, external_event_id),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS workspace_entitlements_workspace_status_idx
  ON workspace_entitlements(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS workspace_memberships_workspace_status_idx
  ON workspace_memberships(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS workspace_provisioning_events_workspace_received_idx
  ON workspace_provisioning_events(workspace_id, received_at DESC);

ALTER TABLE workspace_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_entitlements FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_provisioning_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_provisioning_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_entitlements_isolation ON workspace_entitlements;
CREATE POLICY workspace_entitlements_isolation ON workspace_entitlements
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS workspace_memberships_isolation ON workspace_memberships;
CREATE POLICY workspace_memberships_isolation ON workspace_memberships
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS workspace_provisioning_events_isolation ON workspace_provisioning_events;
CREATE POLICY workspace_provisioning_events_isolation ON workspace_provisioning_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
