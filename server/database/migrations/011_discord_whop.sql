-- Authentication/provisioning directories are server-only, like solo_accounts.
ALTER TABLE workspaces ADD COLUMN access_source text NOT NULL DEFAULT 'manual'
  CHECK (access_source IN ('manual', 'whop'));
CREATE TABLE discord_identities (
  discord_id text PRIMARY KEY CHECK (discord_id ~ '^[0-9]{17,20}$'),
  username text NOT NULL,
  default_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE discord_bindings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  discord_id text NOT NULL REFERENCES discord_identities(discord_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discord_bindings_identity_idx ON discord_bindings(discord_id);
INSERT INTO discord_identities(discord_id, username, default_workspace_id)
  SELECT discord_id, handle, workspace_id FROM solo_accounts WHERE discord_id IS NOT NULL;
INSERT INTO discord_bindings(workspace_id, discord_id)
  SELECT workspace_id, discord_id FROM solo_accounts WHERE discord_id IS NOT NULL;

CREATE TABLE whop_memberships (
  id text PRIMARY KEY,
  user_id text,
  discord_id text,
  product_type text NOT NULL CHECK (product_type IN ('solo', 'aco')),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  valid boolean NOT NULL DEFAULT false,
  access_until timestamptz NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
CREATE INDEX whop_memberships_workspace_idx ON whop_memberships(workspace_id, access_until);
CREATE TABLE whop_jobs (
  id text PRIMARY KEY,
  membership_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whop_jobs_pending_idx ON whop_jobs(next_attempt_at) WHERE processed_at IS NULL;
REVOKE ALL ON discord_identities, discord_bindings, whop_memberships, whop_jobs FROM PUBLIC;

-- A finite verification lease prevents missed webhooks from granting access forever.
CREATE FUNCTION workspace_has_access(target uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=target AND w.status='active'
    AND (w.access_source='manual' OR EXISTS (SELECT 1 FROM whop_memberships m
      WHERE m.workspace_id=w.id AND m.valid AND m.access_until>now())))
$$;
