-- Individual accounts may connect at most two Gmail inboxes.
UPDATE solo_accounts SET mailbox_limit = LEAST(mailbox_limit, 2) WHERE mailbox_limit > 2;
ALTER TABLE solo_accounts
  ALTER COLUMN mailbox_limit SET DEFAULT 2;
ALTER TABLE solo_accounts
  DROP CONSTRAINT IF EXISTS solo_accounts_mailbox_limit_check;
ALTER TABLE solo_accounts
  ADD CONSTRAINT solo_accounts_mailbox_limit_check CHECK (mailbox_limit BETWEEN 1 AND 2);

-- Shared parser knowledge contains only generic template-noise labels. It is
-- deliberately not workspace-scoped because it contains no customer, order,
-- address, message, or source-excerpt data.
CREATE TABLE IF NOT EXISTS parser_feedback_patterns (
  merchant_key text NOT NULL CHECK (char_length(merchant_key) BETWEEN 1 AND 120),
  item_name text NOT NULL CHECK (char_length(item_name) BETWEEN 2 AND 240),
  example_quantity integer CHECK (example_quantity IS NULL OR example_quantity BETWEEN 1 AND 10000),
  hidden_count integer NOT NULL DEFAULT 0 CHECK (hidden_count >= 0),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_key, item_name)
);
CREATE INDEX IF NOT EXISTS parser_feedback_patterns_rank_idx
  ON parser_feedback_patterns(merchant_key, hidden_count DESC, last_seen_at DESC);
REVOKE ALL ON parser_feedback_patterns FROM PUBLIC;
