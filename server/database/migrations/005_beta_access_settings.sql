ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS portal_token_hash text,
  ADD COLUMN IF NOT EXISTS portal_token_ciphertext text,
  ADD COLUMN IF NOT EXISTS portal_token_created_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS customers_portal_token_hash_idx
  ON customers(portal_token_hash)
  WHERE portal_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT 'ACO Studio',
  logo_url text,
  accent_color text NOT NULL DEFAULT '#1463f3',
  notification_seller_email text,
  venmo_payment_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CHECK (logo_url IS NULL OR logo_url ~* '^https://'),
  CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  CHECK (notification_seller_email IS NULL OR char_length(notification_seller_email) <= 320),
  CHECK (venmo_payment_url IS NULL OR venmo_payment_url ~* '^https://')
);

INSERT INTO workspace_settings(workspace_id, display_name)
SELECT id, name FROM workspaces
ON CONFLICT (workspace_id) DO NOTHING;

ALTER TABLE workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_settings_isolation ON workspace_settings;
CREATE POLICY workspace_settings_isolation ON workspace_settings
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
