-- "How did it get that answer?"
--
-- A grounded answer is only trustworthy if its derivation can be inspected.
-- Citations say which records were used; this says everything else: which
-- chunks retrieval actually picked and how strongly they scored, the literal
-- prompt that was sent, which provider and model answered it, and how long
-- each half took. Enough to reconstruct the answer, or to see why a bad one
-- happened — usually retrieval pulled the wrong evidence, which no amount of
-- staring at the answer text will reveal.
--
-- Rows hold customer text (the prompt embeds the retrieved excerpts). They
-- live in the same database as context_chunks, so this is no new class of
-- exposure — but it is a second copy, which is why the scheduled handler
-- prunes them on a retention window rather than keeping them forever.
CREATE TABLE answer_traces (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(account_id),
  question       TEXT NOT NULL,
  answer         TEXT NOT NULL,
  provider       TEXT NOT NULL,   -- "workers-ai" | "openrouter" | "anthropic"
  model          TEXT NOT NULL,
  prompt         TEXT NOT NULL,   -- exactly what was sent to the model
  chunks         TEXT NOT NULL,   -- JSON: the retrieved evidence, with scores
  retrieval_ms   INTEGER,
  generation_ms  INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX answer_traces_account_idx ON answer_traces (account_id, created_at DESC);
CREATE INDEX answer_traces_created_idx ON answer_traces (created_at);
