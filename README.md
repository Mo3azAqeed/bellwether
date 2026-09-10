# Bellwether

An open-source AI context layer for customer success teams — tells you when
an account is about to walk away, and lets you ask why, right from Slack.

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
| **PostHog** | Source of truth for product usage (`app_opened` events, grouped by account) |
| **Cloudflare D1** | Account metadata, health-snapshot history, and the text behind every retrieved context chunk |
| **Cloudflare Vectorize** | Embeddings of ingested notes (call transcripts, tickets), searched per-account for the "Why?" flow |
| **Workers AI** | Free default for both embeddings and answer generation — see [Configuration](#configuration) to swap in Anthropic or OpenRouter for better answers |
| **Cloudflare Cron Triggers** | Nightly: recompute every account's health tier, and backfill any meeting transcripts a webhook missed |
| **The Worker** (`worker/`) | Everything above, tied together, answering Slack over HTTP (no long-lived process, no Socket Mode) |

`@Bell how is X doing?` computes X's usage live from PostHog against its own
10-day-vs-49-day baseline. `@Bell why is X declining?` (or the **Why?**
button) retrieves the most relevant ingested notes for X and has a model
answer *only* from them, citing sources — it says so plainly rather than
guessing if nothing's been ingested yet.

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
on the RAG features), a Slack workspace you can install an app into, and a
[PostHog](https://posthog.com) project receiving `app_opened` events grouped
by account (see the schema doc linked above).

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

4. **Set secrets** (these never go in `wrangler.jsonc` or get committed):
   ```bash
   npx wrangler secret put SLACK_BOT_TOKEN
   npx wrangler secret put SLACK_SIGNING_SECRET
   npx wrangler secret put POSTHOG_API_KEY
   npx wrangler secret put POSTHOG_PROJECT_ID
   ```

5. **Deploy:**
   ```bash
   npm run deploy
   ```
   Wrangler prints your Worker's URL (`https://bellwether.<you>.workers.dev`).

6. **Create the Slack app.** Open
   [`worker/slack-manifest.json`](worker/slack-manifest.json), replace the
   two `REPLACE-WITH-YOUR-WORKER` URLs with your real Worker URL, then go to
   [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* →
   *From an app manifest* and paste it in.
   - Under **OAuth & Permissions**, install the app and copy the **Bot User
     OAuth Token** (`xoxb-...`) — that's `SLACK_BOT_TOKEN` from step 4.
   - Under **Basic Information**, copy the **Signing Secret** — that's
     `SLACK_SIGNING_SECRET`.
   - Invite `@Bell` to a channel (`/invite @Bell`).

7. Ask `@Bell how is <account name> doing?` in Slack.

## Meeting transcripts & other context (the "Why?" flow)

RAG needs something to retrieve. Three ways to get notes in:

**Fireflies** (recommended first connector — built for exactly this):
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

**Anything else** (Intercom, Zendesk, HubSpot call notes, a manual export —
whatever): the generic ingestion endpoint takes plain text and metadata, so
a Zapier/Make automation or a one-off script can feed it:
```bash
npx wrangler secret put INGEST_API_KEY
curl -X POST https://<your-worker>/ingest \
  -H "Authorization: Bearer $INGEST_API_KEY" -H "content-type: application/json" \
  -d '{"accountId":"acct-001","source":"intercom","text":"...","occurredAt":"2026-09-01"}'
```

All three built-in connectors resolve which account a meeting belongs to by
matching participant email domains against the `account_domains` table —
populate it once per customer:
```bash
echo "INSERT INTO account_domains (domain, account_id) VALUES ('northwind.io', 'acct-001');" \
  | npx wrangler d1 execute bellwether --remote
```
(Falls back to fuzzy-matching the meeting title against account names if no
domain matches.)

### How data stays fresh

- **Usage numbers**: computed live from PostHog on every `@Bell how is X
  doing?`, and additionally recomputed for *every* account each night (Cron
  Trigger, `0 6 * * *` UTC — edit in `worker/wrangler.jsonc`) so trend
  history accumulates even for accounts nobody asked about that day.
- **Meeting transcripts**: Fireflies and Zoom arrive within minutes via
  webhook, the moment a transcript finishes processing. Google Meet is
  nightly-only (see above). The same nightly cron also re-checks the last 2
  days of Fireflies transcripts as a safety net for any webhook delivery
  that failed — so the worst case is same-day, not "silently lost forever."

## Configuration

Secrets (`wrangler secret put <NAME>`), all optional except the Slack/PostHog
core:

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | yes | Verifies requests are from Slack |
| `POSTHOG_API_KEY` | yes | Personal API key with query read access |
| `POSTHOG_PROJECT_ID` | yes | Your PostHog project ID |
| `POSTHOG_HOST` | no | Defaults to `https://eu.posthog.com` |
| `ANTHROPIC_API_KEY` | no | If set, RAG answers use Claude Haiku instead of the free Workers AI model |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | no | If set (and Anthropic isn't), RAG answers route through OpenRouter — one key, choice of model, including genuinely free `:free` models |
| `INGEST_API_KEY` | no | Enables `POST /ingest`; unset = disabled |
| `FIREFLIES_API_KEY` / `FIREFLIES_WEBHOOK_SECRET` | no | Enables the Fireflies connector |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | no | Enables the Zoom connector |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` / `GOOGLE_WORKSPACE_IMPERSONATE_EMAIL` | no | Enables the Google Meet connector |

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

```
worker/                    Cloudflare Worker (the whole app)
  src/index.ts              Routes + the nightly scheduled handler
  src/slack/                Slack HTTP verification, Web API client, Block Kit, event/interaction handlers
  src/baseline.ts            Usage health-tier computation
  src/posthog.ts              PostHog HogQL client
  src/db.ts                    D1 query helpers
  src/rag/                      Chunking, embeddings, ingestion, retrieval, answer generation
  src/connectors/                 Fireflies, Zoom, Google Meet
  migrations/                       D1 schema
data-seed/                 Python pipeline that synthesizes demo accounts + usage history into PostHog
```

## License

[MIT](LICENSE)
