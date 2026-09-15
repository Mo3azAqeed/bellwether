# Contributing

Small contributions are the most welcome ones. A connector for a tool we
don't support, a wrong assumption in the health tiering, a doc page that
lied to you — all of those are worth more than a large refactor nobody
asked for.

No CLA, no contributor agreement. It's MIT; that's the whole deal.

## Before you open a PR

From `worker/`:

```bash
npm test
npm run typecheck
npm run typecheck:scripts
```

There's no CI yet, so those three are the check. A PR that fails them will
just sit there until someone notices, which helps nobody.

## What a good PR looks like

- **One thing.** A connector, a bug, a doc fix. Not three.
- **A test for the part that's easy to get quietly wrong.** Parsing,
  tiering, chunking, anything with a date in it. Not every line needs a
  test; the ones that can be subtly wrong for a month do.
- **Say what you couldn't verify.** If you wrote a connector against the
  vendor's docs but never ran it on a live account, put that in the PR. We
  already ship two like that and say so in the README. An honest gap is
  fine; a silent one isn't.

## Adding a connector

Every connector follows the same shape, and
[docs/development.md](docs/development.md) walks through it. The short
version: fetch, normalize to text with a date and a source reference,
hand it to the ingest path. The interesting decisions are what counts as
one record and how to build a link back to it — get those right and the
rest is mechanical.

You'll also need to register it in `src/env.ts`, the setup registry, the
cron sweep, and the connector table in the docs. `docs/connectors.md` is
the list users read; a connector that isn't in it doesn't exist.

## Style

Match the file you're in. The codebase comments *why*, not *what* —
if a line needs explaining, it's usually because something surprising is
true about the API or the runtime, and that's what the comment should say.

## Reporting a bug

Include what you expected, what happened, and enough to reproduce it. If
it involves customer data, redact it — don't paste a real transcript into
a public issue.

Security issues go to [SECURITY.md](SECURITY.md), not the issue tracker.
