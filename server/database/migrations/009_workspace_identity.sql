ALTER TABLE workspace_settings
  ADD COLUMN theme text NOT NULL DEFAULT 'classic-light'
  CHECK (theme IN ('classic-light', 'slate-light', 'mint-light', 'sand-light',
                   'midnight-dark', 'graphite-dark', 'nord-dark', 'dracula-dark'));

CREATE TABLE workspace_credentials (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  session_version integer NOT NULL DEFAULT 0 CHECK (session_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workspace_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_credentials_isolation ON workspace_credentials
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- NULL denotes historical invoices whose original issuer was not captured.
ALTER TABLE invoices ADD COLUMN company_name text;
