-- Runtime-configurable settings: connector credentials saved through the
-- setup UI (see src/setup/), plus small config knobs like sync frequency
-- and the alerts channel. Deliberately generic (key/value) rather than one
-- column per setting, since the list of connectors keeps growing.
--
-- Anything here overrides the matching Workers secret/var of the same name
-- (see src/settings.ts) — so `wrangler secret put X` still works for anyone
-- who'd rather not put a credential in the database at all; the UI is the
-- friendlier path, not the only one.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
