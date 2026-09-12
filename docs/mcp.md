# Use it from your coding agent

Claude Code, Cursor, Codex and OpenCode all speak MCP, so all four reach the same context layer that answers `@Bell` in Slack — no per-tool integration, just one URL and a token.

The same context layer that answers `@Bell` in Slack or Teams is also
reachable over [MCP](https://modelcontextprotocol.io) (Model Context
Protocol) — so a Customer Success Engineer already living in Claude Code,
Cursor, Codex, or OpenCode can ask about an account without switching to
Slack. Four tools, callable by the agent's model instead of triggered by a
mention:

| Tool | What it does | Server-side model cost |
|---|---|---|
| `list_accounts` | Lists/filters the accounts being tracked | none |
| `get_account_health` | Usage against the account's own baseline, tier, renewal | none |
| `get_account_context` | Returns the raw matching excerpts — transcripts, tickets, CRM notes — verbatim, no summarization | none |
| `ask_about_account` | The RAG "why" flow: retrieves, then has a model answer from only what it found, with citations | one short call |

```bash
npx wrangler secret put MCP_ACCESS_TOKEN   # pick any strong random string
```

Then point your coding agent at `https://<your-worker>/mcp` with that token
as a bearer credential. The exact config lives in a different file per tool,
but the URL and token are the same everywhere:

**Claude Code:**
```bash
claude mcp add --transport http bellwether https://<your-worker>/mcp \
  --header "Authorization: Bearer $MCP_ACCESS_TOKEN"
```

**Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "bellwether": {
      "url": "https://<your-worker>/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):
```toml
[mcp_servers.bellwether]
url = "https://<your-worker>/mcp"
headers = { Authorization = "Bearer <your-token>" }
```

**OpenCode**: add the same URL and bearer header under its MCP server config
— consult OpenCode's own docs for the exact key names, since this one is
less battle-tested here than the other three.

Unset `MCP_ACCESS_TOKEN` and `/mcp` returns 501 — same fail-closed pattern as
`INGEST_API_KEY`. See [`worker/src/mcp/server.ts`](../worker/src/mcp/server.ts)
for the actual tool implementations.

### Who pays for what (bring your own key)

A fair worry before wiring this into Claude Code or Codex: *will this burn
through my credits?* There are two separate budgets here, and you control
both:

1. **Your coding agent's own tokens.** Claude Code, Cursor, and Codex each
   pay for reading a tool's result into their context — that's their
   subscription or API key, and no tool can change it. Bellwether's tool
   results are deliberately short (a health line, a handful of excerpts),
   not whole transcripts.
2. **Bellwether's own model call**, which happens inside *your* Worker with
   *your* key — and three of the four tools don't make one at all. Only
   `ask_about_account` generates, and you choose what generates it:

| Configured | Used for "Why?" answers | Cost |
|---|---|---|
| nothing (default) | Workers AI (`llama-3.1-8b-instruct`) | $0 — included in Workers |
| `OPENROUTER_API_KEY` (+ optional `OPENROUTER_MODEL`) | whatever model you name | your OpenRouter balance |
| `ANTHROPIC_API_KEY` | Claude Haiku | your Anthropic balance |

Anthropic wins if both are set; otherwise OpenRouter; otherwise the free
Workers AI default. Retrieval embeddings always run on Workers AI and never
cost extra.

So if you want cheap-but-better-than-default answers, point it at something
like DeepSeek through OpenRouter:

```bash
npx wrangler secret put OPENROUTER_API_KEY
echo "INSERT INTO settings (key, value, updated_at) VALUES ('OPENROUTER_MODEL', 'deepseek/deepseek-chat', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;" \
  | npx wrangler d1 execute bellwether --remote
```

(Or set both through the setup wizard / `npm run setup`, which is the same
thing with a UI. Check [openrouter.ai/models](https://openrouter.ai/models)
for current pricing, and note some models are genuinely free.)

**And if you'd rather spend nothing server-side at all:** use
`get_account_context` instead of `ask_about_account`. It returns the raw
excerpts and lets your coding agent's own model — which you're already
paying for — do the reasoning. Same retrieval, no second model in the
middle, and you see the source material rather than a summary of it. That's
usually the better tool inside a coding agent anyway; `ask_about_account`
earns its keep in Slack and Teams, where there's no model on the other end.
