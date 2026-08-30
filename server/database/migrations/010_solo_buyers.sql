ALTER TABLE workspaces ADD COLUMN product_type text NOT NULL DEFAULT 'aco'
  CHECK (product_type IN ('aco', 'solo'));

-- Authentication directory, like workspaces: server-only lookups by an opaque
-- serial hash or verified Discord ID. Customer/order data stays behind workspace RLS.
CREATE TABLE solo_accounts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  handle text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  discord_id text UNIQUE CHECK (discord_id IS NULL OR discord_id ~ '^[0-9]{17,20}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  serial_hash text NOT NULL UNIQUE,
  access_expires_at timestamptz NOT NULL,
  mailbox_limit integer NOT NULL DEFAULT 5 CHECK (mailbox_limit BETWEEN 1 AND 100),
  session_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON solo_accounts FROM PUBLIC;
