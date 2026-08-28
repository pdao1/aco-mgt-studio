CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION status_rank(value text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE value
    WHEN 'confirmed' THEN 1
    WHEN 'processing' THEN 2
    WHEN 'shipped' THEN 3
    WHEN 'delivered' THEN 4
    WHEN 'cancelled' THEN 5
    ELSE 0
  END
$$;

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  gmail_address text NOT NULL,
  sync_days integer NOT NULL DEFAULT 90 CHECK (sync_days BETWEEN 1 AND 3650),
  sync_status text NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced', 'syncing', 'warning', 'error')),
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, gmail_address),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS customer_mailboxes (
  customer_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  secret_ciphertext text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES customers(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  merchant text NOT NULL,
  order_number text NOT NULL,
  ordered_at timestamptz NOT NULL,
  total_cents integer CHECK (total_cents IS NULL OR total_cents >= 0),
  item_count integer CHECK (item_count IS NULL OR item_count >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL CHECK (status IN ('confirmed', 'processing', 'shipped', 'delivered', 'cancelled')),
  source_message_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES customers(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, customer_id, merchant, order_number),
  UNIQUE (workspace_id, customer_id, id)
);

CREATE TABLE IF NOT EXISTS shipments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  order_id uuid NOT NULL,
  carrier text,
  tracking_number text,
  tracking_url text,
  status text NOT NULL CHECK (status IN ('confirmed', 'processing', 'shipped', 'delivered', 'cancelled')),
  expected_delivery timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, customer_id, order_id) REFERENCES orders(workspace_id, customer_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, customer_id, tracking_number),
  UNIQUE (workspace_id, customer_id, order_id)
);

CREATE TABLE IF NOT EXISTS order_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  order_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('confirmed', 'processing', 'shipped', 'delivered', 'cancelled')),
  label text NOT NULL,
  detail text NOT NULL,
  occurred_at timestamptz NOT NULL,
  source_message_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, customer_id, order_id) REFERENCES orders(workspace_id, customer_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, order_id, status, source_message_key)
);

CREATE TABLE IF NOT EXISTS processed_messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  message_key text NOT NULL,
  sender_domain text,
  subject text NOT NULL,
  received_at timestamptz NOT NULL,
  matched_order boolean NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES customers(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, customer_id, message_key)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  messages_scanned integer NOT NULL DEFAULT 0,
  orders_matched integer NOT NULL DEFAULT 0,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (workspace_id, customer_id) REFERENCES customers(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS customers_workspace_updated_idx ON customers(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS orders_customer_ordered_idx ON orders(workspace_id, customer_id, ordered_at DESC);
CREATE INDEX IF NOT EXISTS shipments_customer_status_idx ON shipments(workspace_id, customer_id, status);
CREATE INDEX IF NOT EXISTS events_order_time_idx ON order_events(workspace_id, order_id, occurred_at);
CREATE INDEX IF NOT EXISTS processed_customer_received_idx ON processed_messages(workspace_id, customer_id, received_at DESC);
CREATE INDEX IF NOT EXISTS sync_runs_customer_started_idx ON sync_runs(workspace_id, customer_id, started_at DESC);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_mailboxes FORCE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments FORCE ROW LEVEL SECURITY;
ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events FORCE ROW LEVEL SECURITY;
ALTER TABLE processed_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customers_workspace_isolation ON customers;
CREATE POLICY customers_workspace_isolation ON customers
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS mailboxes_workspace_isolation ON customer_mailboxes;
CREATE POLICY mailboxes_workspace_isolation ON customer_mailboxes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS orders_workspace_isolation ON orders;
CREATE POLICY orders_workspace_isolation ON orders
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS shipments_workspace_isolation ON shipments;
CREATE POLICY shipments_workspace_isolation ON shipments
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS events_workspace_isolation ON order_events;
CREATE POLICY events_workspace_isolation ON order_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS processed_workspace_isolation ON processed_messages;
CREATE POLICY processed_workspace_isolation ON processed_messages
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS sync_runs_workspace_isolation ON sync_runs;
CREATE POLICY sync_runs_workspace_isolation ON sync_runs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
