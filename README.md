# Bellwether

An open-source AI context layer for customer success teams — tells you when
an account is about to walk away, and lets you ask why, right from Slack or
Microsoft Teams.

Runs entirely on Cloudflare (Workers, D1, Vectorize, Workers AI, Cron
Triggers): no server to keep alive, no database to patch, and it's
self-hosted — you deploy it into *your own* Cloudflare account with *your
own* keys, so nothing about your customers ever passes through infrastructure
anyone else runs. See [Privacy](#privacy) below.

```
🔴 Northwind
Not great. Usage has been pulling away and it's down 52% against its own baseline.

Active seats (10-day avg)   Against baseline   Renewal        Owner
4 of 12                     -52%               in 23 days     Maya

[View account]  [Assign owner]  [Why?]
```

```
@Bell why is Northwind declining?

Northwind: Their admin champion left in August and the replacement hasn't
been onboarded yet [1]. Support also flagged a blocked SSO renewal that's
stopping new users from logging in [2].

Sources:
• zoom · 2026-08-14: "...our admin Sarah actually left the company last month..."
• intercom · 2026-08-22: "SSO cert expired, blocking new logins for..."
```

## How it works

| Piece | What it does |
|---|---|
| **PostHog or Mixpanel** | Source of truth for product usage — pick one via `USAGE_PROVIDER` (defaults to PostHog); see [Configuration](#configuration) |
| **Cloudflare D1** | Account metadata, health-snapshot history, and the text behind every retrieved context chunk |
| **Cloudflare Vectorize** | Embeddings of ingested notes (call transcripts, tickets), searched per-account for the "Why?" flow |
| **Workers AI** | Free default for both embeddings and answer generation — see [Configuration](#configuration) to swap in Anthropic or OpenRouter for better answers |
| **Cloudflare Cron Triggers** | On the interval you pick in the setup wizard (4h/8h/12h/24h): recompute every account's health tier, alert Slack on any tier change, and backfill anything a connector's webhook missed |
| **The Worker** (`worker/`) | Everything above, tied together, answering Slack, Teams, and MCP-speaking coding agents over plain HTTP (no long-lived process, no Socket Mode) |
| **The setup wizard** (`/setup`) | A page the Worker serves itself — connect each integration one at a time, test the credential live, and it's saved straight to your D1 database. See [Setup wizard](#setup-wizard) — or skip the browser entirely and use `npm run setup` (see [CLI setup](#cli-setup)) |

Slack, Teams, and MCP (see [below](#mcp-use-it-from-your-coding-agent)) are
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

See [`data-seed/schema.md`](data-seed/schema.md) for the PostHog event schema
this expects, and [`worker/migrations/`](worker/migrations/) for the D1
schema.

## Cost

Realistic floor for a small deployment:

| | |
|---|---|
| Workers | Free up to 100K requests/day |
| D1 | Free up to 5GB storage, 5M rows read/day, 100K rows written/day |
| Vectorize | **Requires the $5/mo Workers Paid plan** — not available on the free plan at all |
| Workers AI (embeddings + generation) | Included, no separate charge, generous free allowance |

So: **$0/month** if you skip the RAG/transcript features, **$5/month** (the
Workers Paid plan minimum) once you turn them on — flat, not metered per
account. Compare to the enterprise CS platforms this replaces, which quote
$30K+/year.

## Privacy

There is no Bellwether-run backend. Every deployment is a fork running in
*your* Cloudflare account: your Slack tokens, your PostHog project, your D1
database, your Vectorize index. Nobody else — including whoever wrote this
code — has access to your data, because there's no shared service for it to
pass through. If you want that guarantee to mean something, verify it
yourself: this repo is the whole thing, nothing calls home.

## Deploy

You'll need a [Cloudflare account](https://dash.cloudflare.com/sign-up)
(free to create — the $5/mo Workers Paid plan is only required if you turn
on the RAG features), a Slack workspace and/or a Microsoft 365 tenant you can
register a bot in (connect either or both), and a [PostHog](https://posthog.com)
project receiving `app_opened` events grouped by account (see the schema doc
linked above).

```bash
cd worker
npm install
npx wrangler login
```

1. **Create the D1 database and Vectorize index**, then paste the printed
   database ID into `wrangler.jsonc` (`d1_databases[0].database_id`):
   ```bash
   npx wrangler d1 create bellwether
   npx wrangler vectorize create bellwether-context --dimensions=768 --metric=cosine
   ```

2. **Apply the schema:**
   ```bash
   npm run db:migrate:remote
   ```

3. **Load your accounts.** Shape your data like
   [`data-seed/accounts.json`](data-seed/accounts.json), then:
   ```bash
   npm run seed:sql > seed.sql
   npx wrangler d1 execute bellwether --remote --file=seed.sql
   ```

4. **Set the secrets for whichever chat platform(s) you're using, plus
   `SETUP_ADMIN_TOKEN`** (these never go in `wrangler.jsonc` or get
   committed) — connect at least one platform for the bot to be reachable
   anywhere:
   ```bash
   npx wrangler secret put SETUP_ADMIN_TOKEN   # pick any strong random string — gates the /setup wizard, required regardless

   # Slack:
   npx wrangler secret put SLACK_BOT_TOKEN
   npx wrangler secret put SLACK_SIGNING_SECRET

   # Teams:
   npx wrangler secret put MICROSOFT_APP_ID
   npx wrangler secret put MICROSOFT_APP_PASSWORD
   ```
   PostHog/Mixpanel and every other connector's credentials do **not** need
   `wrangler secret put` — you'll add those through the setup wizard or the
   CLI (steps 7-8), which save straight to your D1 database (no redeploy
   needed). Use `wrangler secret put` for those too only if you'd rather not
   put a credential in the database at all; see
   [Configuration](#configuration) for the full list of env var names
   either path uses.

5. **Deploy:**
   ```bash
   npm run deploy
   ```
   Wrangler prints your Worker's URL (`https://bellwether.<you>.workers.dev`).

6. **Create the Slack app and/or the Teams bot** (whichever you're using):

   **Slack** — open [`worker/slack-manifest.json`](worker/slack-manifest.json),
   replace the two `REPLACE-WITH-YOUR-WORKER` URLs with your real Worker
   URL, then go to [api.slack.com/apps](https://api.slack.com/apps) →
   *Create New App* → *From an app manifest* and paste it in.
   - Under **OAuth & Permissions**, install the app and copy the **Bot User
     OAuth Token** (`xoxb-...`) — that's `SLACK_BOT_TOKEN` from step 4.
   - Under **Basic Information**, copy the **Signing Secret** — that's
     `SLACK_SIGNING_SECRET`.
   - Invite `@Bell` to a channel (`/invite @Bell`).

   **Teams** — in the [Azure Portal](https://portal.azure.com), create an
   "Azure Bot" resource with messaging endpoint
   `https://<your-worker>/api/messages`. That creates a linked Azure AD app
   registration:
   - Copy the bot's **Microsoft App ID** — that's `MICROSOFT_APP_ID`.
   - Under the app registration's **Certificates & secrets**, create a
     client secret — that's `MICROSOFT_APP_PASSWORD`.
   - Under the bot resource's **Channels**, add the **Microsoft Teams**
     channel.
   - Sideload the bot into a team (or DM it directly) via Teams' app
     upload flow.

7. **Open the setup wizard** at `https://<your-worker>/setup`, enter the
   `SETUP_ADMIN_TOKEN` you set in step 4, and connect PostHog (or Mixpanel)
   plus whichever context sources you want — see
   [Setup wizard](#setup-wizard) below. Or use `npm run setup` instead — see
   [CLI setup](#cli-setup).

8. Ask `@Bell how is <account name> doing?` in Slack, or just message the
   bot directly in Teams.

## Setup wizard

`https://<your-worker>/setup` is a page the Worker serves itself — no
separate service, no frontend build, just static HTML/JS this repo ships.
Enter your `SETUP_ADMIN_TOKEN` once (kept in the browser's `localStorage`
after that) and you get a grid of every integration, one screen per
connector:

1. Pick one (PostHog, Fireflies, HubSpot, whatever).
2. Short instructions for where to get the credential, and a form for it.
3. **Test & Connect** makes one real request to that service to confirm the
   credential actually works, *then* saves it — nothing gets stored on a
   failed test. Where a live test isn't possible (Zoom's webhook secret only
   verifies inbound requests, for instance) it just saves.
4. **Skip for now** if you're not ready to wire that one up yet — it stays
   visibly "skipped" on the dashboard rather than looking broken.

Everything saved this way goes into your own D1 database (the `settings`
table), not a Workers secret — that's what makes "paste it, watch it turn
green" possible without a redeploy. If you'd rather a credential never touch
the database at all, `wrangler secret put <NAME>` for that variable still
works exactly the same; D1 is only checked first, with the Workers
secret/var as a fallback (src/settings.ts). One credential is deliberately
*not* editable from here: `SETUP_ADMIN_TOKEN` itself, which only ever comes
from `wrangler secret put`, set before your first deploy — otherwise the
page that gates access to everything else could grant access to itself.

The wizard is also where you set the **alerts channel** (a Slack channel ID
Bellwether posts to whenever an account's tier changes) and the **sync
frequency** (see [How data stays fresh](#how-data-stays-fresh)) — both save
instantly, no redeploy. Microsoft Teams' own credentials
(`MICROSOFT_APP_ID`/`MICROSOFT_APP_PASSWORD`) show up here too, under
"Bots," with a real live test (they're checked against Microsoft's own
token endpoint) — everything except Slack itself can be configured from
this one page.

## CLI setup

Prefer never opening a browser for this: `npm run setup` (writes to your
deployed/remote database) or `npm run setup:local` (writes to a local
`wrangler dev` database instead) is the exact same integration list, the
exact same live "test before saving" behavior — it's the same code, just
driven from a terminal menu instead of clicking cards. No
`SETUP_ADMIN_TOKEN` needed for this path either: it writes to D1 directly
via `wrangler d1 execute` (the same mechanism `npm run seed:sql` uses),
never touching the deployed Worker's HTTP API at all.

```
$ npm run setup

Integrations:
  1. 📊  PostHog — Product usage data — powers the health-tier calculation.
  2. 📈  Mixpanel — Alternative to PostHog for usage data...
  ...
  11. 🟦  Microsoft Teams — The same @Bell-style bot as Slack, for Teams instead...
  12. Sync frequency
  13. Alerts channel
  0. Done

Pick a number: 1
📊  PostHog
PostHog → Settings → Personal API Keys → create one with query read access...
  API key: phx_...
  Project ID: 95813
  Host (optional, defaults to eu.posthog.com):
  Testing...
  ✓ Connected.
  Saved. Takes effect immediately — no redeploy needed.
```

Slack and Teams themselves still need their own app registration (a manifest,
an Azure Bot resource) — that's step 6 in [Deploy](#deploy), not something a
credential-only CLI can do for you.

## Meeting transcripts & other context (the "Why?" flow)

RAG needs something to retrieve. Six built-in connectors (configure them
through the [setup wizard](#setup-wizard) above, or by hand below), plus a
generic endpoint for anything else:

**Fireflies** (recommended first meeting-transcript connector — built for exactly this):
```bash
npx wrangler secret put FIREFLIES_API_KEY        # from Fireflies → Settings → Developer Settings
npx wrangler secret put FIREFLIES_WEBHOOK_SECRET  # any string you choose
```
In Fireflies' webhook settings, add `https://<your-worker>/webhooks/fireflies?secret=<the same string>`,
subscribed to "Transcription completed".

**Zoom** (no extra subscription if you already have Zoom):
```bash
npx wrangler secret put ZOOM_WEBHOOK_SECRET_TOKEN  # from your Zoom Marketplace app
```
Create a Zoom Marketplace app → Webhooks, subscribe to *"All Recordings have
completed transcription"*, and set its event notification URL to
`https://<your-worker>/webhooks/zoom`. Zoom will immediately send a
validation challenge — the Worker answers it automatically.

**Google Meet** (Workspace only, nightly backfill rather than real-time —
see the caveats in `worker/src/connectors/google-meet.ts`):
```bash
# service-account.json is what Google Cloud gives you when you create the
# service account's key — pull the two fields wrangler needs out of it:
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL   # paste the "client_email" value
jq -r .private_key service-account.json | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
npx wrangler secret put GOOGLE_WORKSPACE_IMPERSONATE_EMAIL
```
Requires a Google Cloud service account with Workspace domain-wide
delegation, scoped to `meetings.space.readonly`. No webhook to configure —
the nightly cron pulls the last 2 days of transcripts.

**Intercom** (support conversations):
```bash
npx wrangler secret put INTERCOM_ACCESS_TOKEN   # private app / access token with read_conversations
npx wrangler secret put INTERCOM_CLIENT_SECRET  # signs webhook deliveries
```
In your Intercom app's Webhooks settings, subscribe to
`conversation.admin.closed` pointed at `https://<your-worker>/webhooks/intercom`.

**Zendesk** (support tickets):
```bash
npx wrangler secret put ZENDESK_SUBDOMAIN       # "yourcompany" in yourcompany.zendesk.com
npx wrangler secret put ZENDESK_EMAIL           # the agent/admin the API token belongs to
npx wrangler secret put ZENDESK_API_TOKEN
npx wrangler secret put ZENDESK_WEBHOOK_SECRET  # any string you choose
```
Create a Zendesk Trigger (Admin Center → Objects and rules → Triggers) on
"Status changed to Solved" with action "Notify webhook", body
`{ "ticketId": "{{ticket.id}}" }`, pointed at
`https://<your-worker>/webhooks/zendesk?secret=<the same string>`.

**HubSpot** (CRM notes — calls, meeting logs on a company/deal; nightly
backfill, no webhook to configure):
```bash
npx wrangler secret put HUBSPOT_ACCESS_TOKEN   # private app with crm.objects.notes.read + crm.objects.companies.read
```

**Anything else** (a manual export, a different helpdesk, a spreadsheet —
whatever): the generic ingestion endpoint takes plain text and metadata, so
a Zapier/Make automation or a one-off script can feed it:
```bash
npx wrangler secret put INGEST_API_KEY
curl -X POST https://<your-worker>/ingest \
  -H "Authorization: Bearer $INGEST_API_KEY" -H "content-type: application/json" \
  -d '{"accountId":"acct-001","source":"manual","text":"...","occurredAt":"2026-09-01"}'
```

All of the built-in connectors resolve which account a document belongs to
by matching a participant/requester email domain (or a HubSpot company's
domain) against the `account_domains` table — populate it once per customer:
```bash
echo "INSERT INTO account_domains (domain, account_id) VALUES ('northwind.io', 'acct-001');" \
  | npx wrangler d1 execute bellwether --remote
```
(Falls back to fuzzy-matching the meeting title against account names if no
domain matches.)

### How data stays fresh

- **Usage numbers**: computed live from PostHog or Mixpanel on every `@Bell
  how is X doing?` — that always runs fresh, regardless of anything below.
  Additionally recomputed for *every* account on a schedule you pick in the
  setup wizard (4h / 8h / 12h / 24h, default 24h) so trend history
  accumulates for accounts nobody asked about, and so tier-change alerts
  (below) actually fire. The underlying Cron Trigger fires every 4 hours no
  matter what (`worker/wrangler.jsonc`); the chosen frequency decides
  whether each firing actually does the work or is a cheap no-op.
- **Support conversations & meeting transcripts**: Fireflies, Zoom,
  Intercom, and Zendesk all arrive within minutes via webhook, as soon as
  the underlying event (call transcribed, ticket solved) happens — that part
  isn't on the frequency schedule above. Google Meet and HubSpot are
  backfill-only (same schedule as usage numbers above — real-time would need
  infrastructure outside Cloudflare for Meet, and a public-app webhook
  subscription for HubSpot). Each due run also re-checks the last 2 days of
  Fireflies transcripts as a safety net for any webhook delivery that
  failed — so the worst case for any source is one sync interval, not
  "silently lost forever."
- **Alerts**: if you set an alerts channel in the wizard, every due sync run
  compares each account's new tier against its previous one and posts to
  Slack on any change (up or down) — see the example near the top of this
  README.

## MCP: use it from your coding agent

The same context layer that answers `@Bell` in Slack or Teams is also
reachable over [MCP](https://modelcontextprotocol.io) (Model Context
Protocol) — so a Customer Success Engineer already living in Claude Code,
Cursor, Codex, or OpenCode can ask about an account without switching to
Slack. It's the same three questions, just callable by the agent's model
instead of triggered by a mention: `list_accounts`, `get_account_health`,
and `ask_about_account` (the RAG "why" flow, with citations).

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
`INGEST_API_KEY`. See [`worker/src/mcp/server.ts`](worker/src/mcp/server.ts)
for the actual tool implementations.

## Configuration

Every row below can be set either through the [setup wizard](#setup-wizard)
(saved to D1) — or the [CLI](#cli-setup), which is the same thing — or as a
Workers secret/var (`wrangler secret put <NAME>`, or a plain var in
`wrangler.jsonc` for non-secret ones); D1 is checked first, so the wizard/CLI
always win if both are set (`src/settings.ts`). `SETUP_ADMIN_TOKEN` plus at
least one of the Slack or Teams pairs are required before your first
deploy, because they're needed to reach the bot or the wizard at all —
everything else can wait until you're through the wizard:

| Variable | Required | Description |
|---|---|---|
| `SETUP_ADMIN_TOKEN` | yes, secret only | Gates `/setup` — never settable through the UI itself |
| `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` | if using Slack, secret only | Bot User OAuth Token, and the secret that verifies requests are from Slack |
| `MICROSOFT_APP_ID` / `MICROSOFT_APP_PASSWORD` | if using Teams | The Azure Bot's app ID and client secret — wizard/CLI-settable, unlike Slack's |
| `USAGE_PROVIDER` | no | `posthog` (default) or `mixpanel` |
| `POSTHOG_API_KEY` / `POSTHOG_PROJECT_ID` | if using PostHog | Personal API key with query read access, and project ID |
| `POSTHOG_HOST` | no | Defaults to `https://eu.posthog.com` |
| `MIXPANEL_PROJECT_ID` / `MIXPANEL_SERVICE_ACCOUNT_USERNAME` / `MIXPANEL_SERVICE_ACCOUNT_SECRET` | if using Mixpanel | A [service account](https://developer.mixpanel.com/reference/service-accounts) with query access |
| `MIXPANEL_HOST` | no | Defaults to `https://mixpanel.com`; use `https://eu.mixpanel.com` for EU-residency projects |
| `MIXPANEL_ACTIVE_EVENT_NAME` / `MIXPANEL_ACCOUNT_PROPERTY` | no | Defaults to `app_opened` / `account_id` — set to match your own instrumentation |
| `ANTHROPIC_API_KEY` | no | If set, RAG answers use Claude Haiku instead of the free Workers AI model |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | no | If set (and Anthropic isn't), RAG answers route through OpenRouter — one key, choice of model, including genuinely free `:free` models |
| `INGEST_API_KEY` | no | Enables `POST /ingest`; unset = disabled |
| `MCP_ACCESS_TOKEN` | no | Enables `POST /mcp` for coding agents (Claude Code, Cursor, Codex, OpenCode); unset = disabled |
| `FIREFLIES_API_KEY` / `FIREFLIES_WEBHOOK_SECRET` | no | Enables the Fireflies connector |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | no | Enables the Zoom connector |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` / `GOOGLE_WORKSPACE_IMPERSONATE_EMAIL` | no | Enables the Google Meet connector |
| `INTERCOM_ACCESS_TOKEN` / `INTERCOM_CLIENT_SECRET` | no | Enables the Intercom connector |
| `ZENDESK_SUBDOMAIN` / `ZENDESK_EMAIL` / `ZENDESK_API_TOKEN` / `ZENDESK_WEBHOOK_SECRET` | no | Enables the Zendesk connector |
| `HUBSPOT_ACCESS_TOKEN` | no | Enables the HubSpot connector |
| `SLACK_ALERTS_CHANNEL` | no | Slack channel ID alerts post to on a tier change; unset = alerting off |
| `SYNC_FREQUENCY_HOURS` | no | `4`, `8`, `12`, or `24` (default) — see [How data stays fresh](#how-data-stays-fresh) |

## Local development

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # fill in Slack/PostHog values
npm run db:migrate:local
npm run dev                       # wrangler dev, local D1 + simulated bindings
npm test                          # unit tests (health tiers, chunking, VTT parsing)
npm run typecheck
```

Slack needs a public HTTPS URL to send events to, so point its request URLs
(step 6 above) at a tunnel (`wrangler dev --remote`, or `cloudflared tunnel`)
when testing against a real workspace locally.

## Repo layout

Using a coding agent (Claude Code, Cursor, Codex, OpenCode)? See
[`AGENTS.md`](AGENTS.md) first — it has a step-by-step playbook for asking
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
  src/connectors/                     Fireflies, Zoom, Google Meet, Intercom, Zendesk, HubSpot
  src/mcp/                              MCP server for coding agents — same tools as @Bell, over POST /mcp
  scripts/setup-cli.ts                Terminal alternative to the /setup wizard
  migrations/                           D1 schema
data-seed/                 Python pipeline that synthesizes demo accounts + usage history into PostHog
```

## License

[MIT](LICENSE)
