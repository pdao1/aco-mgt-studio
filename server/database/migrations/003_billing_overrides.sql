ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS billing_invoice_id uuid,
  ADD COLUMN IF NOT EXISTS status_override text,
  ADD COLUMN IF NOT EXISTS override_note text,
  ADD COLUMN IF NOT EXISTS override_updated_at timestamptz;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_status_override_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_status_override_check
  CHECK (status_override IS NULL OR status_override IN ('confirmed', 'processing', 'shipped', 'delivered', 'cancelled'));

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  invoice_number text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency char(3) NOT NULL DEFAULT 'USD',
  subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0),
  fee_cents integer NOT NULL CHECK (fee_cents >= 0),
  total_cents integer NOT NULL CHECK (total_cents = subtotal_cents + fee_cents),
  due_at timestamptz,
  paid_at timestamptz,
  stripe_customer_id text,
  stripe_invoice_id text,
  hosted_invoice_url text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES customers(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, customer_id, id),
  UNIQUE (workspace_id, invoice_number),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, stripe_invoice_id)
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  order_id uuid NOT NULL,
  description text NOT NULL,
  subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0),
  fee_basis_points integer NOT NULL CHECK (fee_basis_points BETWEEN 0 AND 10000),
  fee_cents integer NOT NULL CHECK (fee_cents >= 0),
  total_cents integer NOT NULL CHECK (total_cents = subtotal_cents + fee_cents),
  currency char(3) NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, customer_id, invoice_id) REFERENCES invoices(workspace_id, customer_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, customer_id, order_id) REFERENCES orders(workspace_id, customer_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, invoice_id, order_id)
);

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_billing_invoice_fk;

ALTER TABLE orders
  ADD CONSTRAINT orders_billing_invoice_fk
  FOREIGN KEY (billing_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS stripe_events (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoices_customer_created_idx ON invoices(workspace_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS invoice_lines_invoice_idx ON invoice_lines(workspace_id, invoice_id);
CREATE INDEX IF NOT EXISTS orders_billing_invoice_idx ON orders(workspace_id, billing_invoice_id);
CREATE INDEX IF NOT EXISTS orders_override_idx ON orders(workspace_id, customer_id, status_override);
CREATE INDEX IF NOT EXISTS stripe_events_received_idx ON stripe_events(workspace_id, received_at DESC);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoices_workspace_isolation ON invoices;
CREATE POLICY invoices_workspace_isolation ON invoices
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS invoice_lines_workspace_isolation ON invoice_lines;
CREATE POLICY invoice_lines_workspace_isolation ON invoice_lines
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS stripe_events_workspace_isolation ON stripe_events;
CREATE POLICY stripe_events_workspace_isolation ON stripe_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
