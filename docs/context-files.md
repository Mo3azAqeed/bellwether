# The context layer as files

Pull the whole thing down as markdown you can read, grep and diff.

MCP is one way in. The other is to pull the whole context layer down as a
folder of markdown you can read, grep, and diff:

```bash
cd worker
npm run context:pull          # your deployed database
npm run context:pull:local    # the local wrangler dev one
```

It reads D1 directly through `wrangler d1 execute --json`, so it needs
nothing but a `wrangler login` — no deployed Worker, no `MCP_ACCESS_TOKEN`,
no `SETUP_ADMIN_TOKEN`. You get:

```
context/
  README.md                              every account, its tier, renewal, document count
  accounts/
    northwind/
      account.md                         the facts, health history, an index of what's on file
      notes/
        2026-08-14-zoom-rec-8891.md      one file per ingested document
        2026-08-22-intercom-conv-4412.md
```

Each note carries YAML frontmatter naming its account, source, source ref
and date, then the source text itself — not a summary of it. Documents that
were chunked for retrieval are put back together in one piece, because
chunking is a retrieval detail and nobody reading a transcript wants it in
four parts.

**Why bother, when MCP already answers the same questions?** Because a
coding agent reads files natively and for free — no protocol round trip, no
tokens spent on tool plumbing, and no model in the middle deciding what's
relevant. It also makes the context layer *reviewable*: `git diff` between
two pulls shows how an account's story changed over a fortnight, which no
live query can. Point Claude Code, Cursor, or Codex at `context/` and it
will read what it needs.

Use MCP for the things files can't give you: usage computed live right now
(`get_account_health`), or semantic search across a history too large to
read (`get_account_context`).

A few deliberate choices worth knowing:

- **`context/` is gitignored by default.** It materializes real customer
  transcripts, tickets and CRM notes onto disk. Committing it would put your
  customers' data in every clone of this repo. Un-ignore it only if you've
  decided, on purpose, that this repo is the right home for that.
- **Nothing is ever deleted.** Files that no longer match a row are listed
  at the end of the run for you to remove yourself — silently deleting
  something a person may have edited is worse than a stale file.
- **Everything is regenerated.** Edit the source systems, not these files;
  your next pull overwrites them.
- `--out <dir>` writes somewhere other than `./context`.
