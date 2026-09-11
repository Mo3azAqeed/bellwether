CREATE TABLE accounts (
  account_id         TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  plan               TEXT NOT NULL,
  seats_purchased    INTEGER NOT NULL,
  renewal_date       TEXT NOT NULL, -- ISO date (YYYY-MM-DD)
  csm_owner_name     TEXT,          -- seed-data placeholder name, shown until a real assignment happens
  csm_owner_slack_id TEXT,          -- real Slack user ID once assigned via the "Assign owner" picker
  usage_pattern      TEXT,          -- ground-truth label from the synthetic seed, kept only for validating the baseline engine
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE health_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          TEXT NOT NULL REFERENCES accounts(account_id),
  checked_at          TEXT NOT NULL DEFAULT (datetime('now')),
  avg_active_seats    INTEGER NOT NULL,
  baseline_delta_pct  REAL NOT NULL,
  tier                TEXT NOT NULL CHECK (tier IN ('stable', 'watch', 'at_risk'))
);

CREATE INDEX health_snapshots_account_checked_idx
  ON health_snapshots (account_id, checked_at DESC);

-- Retriever source material: support tickets, call notes, CRM fields —
-- whatever gets ingested via POST /ingest. The embedding for each row lives
-- in the Vectorize index (CONTEXT_INDEX) under the same id; this table holds
-- the text Vectorize doesn't store, plus enough metadata to cite it back to
-- the user.
CREATE TABLE context_chunks (
  id           TEXT PRIMARY KEY, -- matches the Vectorize vector id
  account_id   TEXT NOT NULL REFERENCES accounts(account_id),
  source       TEXT NOT NULL,    -- e.g. "intercom", "zendesk", "call_notes", "manual"
  source_ref   TEXT,             -- source's own id/URL for this document, if any
  chunk_text   TEXT NOT NULL,
  occurred_at  TEXT,             -- when the underlying event happened (ISO date), if known
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX context_chunks_account_idx ON context_chunks (account_id);
