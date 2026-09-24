ALTER TABLE whop_memberships
  ADD COLUMN access_suspended boolean NOT NULL DEFAULT false;

ALTER TABLE whop_jobs
  ADD COLUMN event_type text NOT NULL DEFAULT 'membership.activated';

CREATE OR REPLACE FUNCTION workspace_has_access(target uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=target AND w.status='active'
    AND (w.access_source='manual' OR EXISTS (SELECT 1 FROM whop_memberships m
      WHERE m.workspace_id=w.id AND m.valid AND NOT m.access_suspended AND m.access_until>now())))
$$;
