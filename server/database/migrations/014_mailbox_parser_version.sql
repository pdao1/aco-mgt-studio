-- Null marks messages processed before replay-safe discovery was introduced.
ALTER TABLE processed_messages ADD COLUMN IF NOT EXISTS parser_version text;
CREATE INDEX IF NOT EXISTS processed_parser_version_idx
  ON processed_messages(workspace_id, customer_id, parser_version);

-- A manual deep scan survives per-run limits, polling, and process restarts.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS backfill_days integer NOT NULL DEFAULT 0
  CHECK (backfill_days BETWEEN 0 AND 365);
