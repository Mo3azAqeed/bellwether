# Architecture

What each piece does, how the three front ends stay consistent with each other, and where everything lives in the repo.

| Piece | What it does |
|---|---|
| **PostHog or Mixpanel** | Source of truth for product usage — pick one via `USAGE_PROVIDER` (defaults to PostHog); see [Configuration](configuration.md) |
| **Cloudflare D1** | Account metadata, health-snapshot history, and the text behind every retrieved context chunk |
| **Cloudflare Vectorize** | Embeddings of ingested notes (call transcripts, tickets), searched per-account for the "Why?" flow |
| **Workers AI** | Free default for both embeddings and answer generation — see [Configuration](configuration.md) to swap in Anthropic or OpenRouter for better answers |
| **Cloudflare Cron Triggers** | On the interval you pick in the setup wizard (4h/8h/12h/24h): recompute every account's health tier, alert Slack on any tier change, and backfill anything a connector's webhook missed |
| **The Worker** (`worker/`) | Everything above, tied together, answering Slack, Teams, and MCP-speaking coding agents over plain HTTP (no long-lived process, no Socket Mode) |
| **The setup wizard** (`/setup`) | A page the Worker serves itself — connect each integration one at a time, test the credential live, and it's saved straight to your D1 database. See [Setup wizard](setup.md) — or skip the browser entirely and use `npm run setup` (see [CLI setup](setup.md#cli-setup)) |

Slack, Teams, and MCP (see [Use it from your coding agent](mcp.md)) are
three front ends on the same brain: `src/bot-logic.ts` parses "how is X
doing?" / "why is X declining?", resolves the account, computes health or
retrieves+generates an answer — all platform-agnostic. Each front end's own
code only handles that platform's transport (HTTP signing, card format,
button/interaction model, or JSON-RPC), so none of them can ever answer the
same question differently.

`@Bell how is X doing?` computes X's usage live from PostHog against its own
10-day-vs-49-day baseline. `@Bell why is X declining?` (or the **Why?**
button) retrieves the most relevant ingested notes for X and has a model
answer *only* from them, citing sources — it says so plainly rather than
guessing if nothing's been ingested yet. Bellwether also doesn't wait to be
asked: set an alerts channel in the setup wizard and it posts there
unprompted whenever an account's tier changes —

```
⚠️ Northwind's health tier just dropped — Stable → Watch

🟡 Northwind
Slowing down. Down 24% against its own baseline over the last few weeks.
...
```

See [`data-seed/schema.md`](../data-seed/schema.md) for the PostHog event schema
this expects, and [`worker/migrations/`](../worker/migrations/) for the D1
schema.

## Repo layout

Using a coding agent (Claude Code, Cursor, Codex, OpenCode)? See
[`AGENTS.md`](../AGENTS.md) first — it has a step-by-step playbook for asking
your agent to deploy and configure a Bellwether instance for you, the same
way you'd walk through `dbt init`.

```
worker/                    Cloudflare Worker (the whole app)
  src/index.ts              Routes + the scheduled handler
  src/bot-logic.ts           Platform-agnostic query parsing + health/RAG resolution, shared by Slack and Teams
  src/slack/                Slack HTTP verification, Web API client, Block Kit, event/interaction handlers
  src/teams/                 Bot Framework JWT verification, Connector API client, Adaptive Cards, activity handlers
  src/baseline.ts            Usage health-tier computation
  src/usage.ts                 Picks PostHog or Mixpanel per USAGE_PROVIDER
  src/posthog.ts, src/mixpanel.ts  The two usage-data clients
  src/db.ts                    D1 query helpers
  src/settings.ts               D1-first, env-fallback credential/config reads
  src/alerts.ts                  Tier-change Slack alerts
  src/sync-schedule.ts             Frequency gate for the scheduled handler
  src/setup/                        Integration registry (shared by the web wizard and the CLI) + wizard page/API routes
  src/rag/                           Chunking, embeddings, ingestion, retrieval, answer generation
  src/connectors/                     Fireflies, Zoom, Google Meet, Intercom, Zendesk, HubSpot, Salesforce, Attio
  src/mcp/                              MCP server for coding agents — same tools as @Bell, over POST /mcp
  src/context/format.ts                  Renders the context layer as markdown (pure; the I/O is in scripts/)
  scripts/setup-cli.ts                Terminal alternative to the /setup wizard
  scripts/context-pull.ts              Pulls D1 down into context/ as a folder of readable markdown
  migrations/                           D1 schema
data-seed/                 Python pipeline that synthesizes demo accounts + usage history into PostHog
```
