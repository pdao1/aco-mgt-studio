ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_item_keys jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_hidden_item_keys_array_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_hidden_item_keys_array_check CHECK (jsonb_typeof(hidden_item_keys) = 'array');

ALTER TABLE processed_messages
  ADD COLUMN IF NOT EXISTS redacted_excerpt text;

CREATE TABLE IF NOT EXISTS parser_feedback (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  order_id uuid,
  merchant text NOT NULL,
  feedback_type text NOT NULL CHECK (feedback_type IN ('archive_order', 'restore_order', 'hide_item', 'restore_item')),
  item_key text,
  item_name text,
  item_quantity integer CHECK (item_quantity IS NULL OR item_quantity BETWEEN 1 AND 10000),
  source_message_key text,
  source_excerpt text,
  prompt_version text NOT NULL DEFAULT 'order-items-repair.v2',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES customers(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, customer_id, order_id) REFERENCES orders(workspace_id, customer_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS parser_feedback_merchant_idx
  ON parser_feedback(workspace_id, merchant, created_at DESC);
CREATE INDEX IF NOT EXISTS parser_feedback_order_idx
  ON parser_feedback(workspace_id, order_id, created_at DESC);

ALTER TABLE parser_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE parser_feedback FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS parser_feedback_workspace_isolation ON parser_feedback;
CREATE POLICY parser_feedback_workspace_isolation ON parser_feedback
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
