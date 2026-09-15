-- Engineering tickets start as drafts and stay drafts until a human says
-- otherwise.
--
-- Bellwether reads everywhere else. This is the one place it can write into
-- someone else's system, and a ticket can't be quietly un-filed: it lands in
-- a backlog, notifies a team, shows up in a sprint. So the draft is stored
-- here first, where it costs nothing and can be read, edited or thrown away,
-- and reaching Linear or Jira takes a separate, explicit approval of a draft
-- that already exists by id.
--
-- Storing it also buys the proactive half: a scheduled run can leave a draft
-- waiting for review without anyone having asked, which is exactly what it
-- must not be able to do directly against a tracker.
CREATE TABLE ticket_drafts (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(account_id),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,   -- markdown, exactly as it will be filed
  evidence     TEXT NOT NULL,   -- JSON: the quotes and their source links
  -- pending  → waiting on a human
  -- filed    → approved and created in the tracker (tracker_key/url set)
  -- discarded→ a human said no; kept so it isn't proposed again
  status       TEXT NOT NULL DEFAULT 'pending',
  origin       TEXT NOT NULL,   -- "mcp", "slack", "scheduled" — who proposed it
  tracker      TEXT,            -- "linear" | "jira", once filed
  tracker_key  TEXT,
  tracker_url  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at   TEXT
);

CREATE INDEX ticket_drafts_pending_idx ON ticket_drafts (status, created_at DESC);
CREATE INDEX ticket_drafts_account_idx ON ticket_drafts (account_id, created_at DESC);
