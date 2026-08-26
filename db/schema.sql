CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS accounts (
  account_id        TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  plan              TEXT NOT NULL,
  seats_purchased   INT NOT NULL,
  renewal_date      DATE NOT NULL,
  csm_owner_name    TEXT,          -- seed-data placeholder name, shown until a real assignment happens
  csm_owner_slack_id TEXT,         -- real Slack user ID once assigned via the "Assign owner" picker
  usage_pattern     TEXT,          -- ground-truth label from the synthetic seed, kept only for validating the baseline engine
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS health_snapshots (
  id                  SERIAL PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(account_id),
  checked_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  avg_active_seats    INT NOT NULL,
  baseline_delta_pct  NUMERIC NOT NULL,
  tier                TEXT NOT NULL CHECK (tier IN ('stable', 'watch', 'at_risk'))
);

CREATE INDEX IF NOT EXISTS health_snapshots_account_checked_idx
  ON health_snapshots (account_id, checked_at DESC);
