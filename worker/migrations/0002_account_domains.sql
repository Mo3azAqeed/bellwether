-- Maps an email domain to an account, so an inbound meeting transcript
-- (whose payload has participant emails, not an account_id) can be routed
-- automatically. Populate this yourself — e.g. one row per customer's
-- corporate domain — there's no reliable way to infer it from a transcript
-- alone.
CREATE TABLE account_domains (
  domain      TEXT PRIMARY KEY, -- e.g. "northwind.io", lowercase, no "@"
  account_id  TEXT NOT NULL REFERENCES accounts(account_id)
);
