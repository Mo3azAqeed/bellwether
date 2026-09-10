# Bellwether

A Slack bot that tells you when a customer account is about to walk away.

Mention `@Bell` in Slack — "how is Northwind doing?" — and it pulls the
account's product usage from PostHog, compares it against its own historical
baseline, and posts a health card: stable, watch, or at risk, plus renewal
date and account owner. Every check is logged so you can see how an
account's trend has moved over time.

```
🔴 Northwind
Not great. Usage has been pulling away and it's down 52% against its own baseline.

Active seats (10-day avg)   Against baseline   Renewal        Owner
4 of 12                     -52%               in 23 days     Maya

[View account]  [Assign owner]
```

## How it works

- **PostHog** is the source of truth for product usage (`app_opened` events,
  grouped by account).
- **Postgres** stores account metadata (plan, seats, renewal date, owner) and
  a history of computed health snapshots.
- **The bot** (Node/TypeScript, [Slack Bolt](https://slack.dev/bolt-js/)) ties
  the two together: on `@Bell how is X doing?` it fetches X's daily active
  seats, computes a 10-day-vs-49-day baseline delta, and replies in Slack.

See [`data-seed/schema.md`](data-seed/schema.md) for the PostHog event schema
this expects, and [`db/schema.sql`](db/schema.sql) for the Postgres schema.

## Quick start (Docker)

You need a Slack workspace you can install an app into, and a
[PostHog](https://posthog.com) project already receiving `app_opened` events
grouped by account (see the schema doc above). This does **not** need any
Node, TypeScript, or Postgres tooling installed locally — just Docker.

1. **Create the Slack app.** Go to
   [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* →
   *From an app manifest*, pick your workspace, and paste in the contents of
   [`app/slack-manifest.json`](app/slack-manifest.json). This sets up the bot
   user, permissions, and event subscriptions for you.
   - Under **OAuth & Permissions**, install the app to your workspace and
     copy the **Bot User OAuth Token** (`xoxb-...`).
   - Under **Basic Information → App-Level Tokens**, create a token with the
     `connections:write` scope and copy it (`xapp-...`).
   - Also under **Basic Information**, copy the **Signing Secret**.
   - Invite `@Bell` to a channel (`/invite @Bell`).

2. **Get your PostHog credentials.** In PostHog, create a personal API key
   (Settings → Personal API keys) with query read access, and note your
   project ID (Settings → Project).

3. **Configure environment variables.**
   ```bash
   cp app/.env.example app/.env
   ```
   Fill in `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`,
   `POSTHOG_API_KEY`, and `POSTHOG_PROJECT_ID`. Leave `DATABASE_URL` as-is —
   Docker Compose points it at the bundled Postgres container.

4. **Start everything.**
   ```bash
   docker compose up --build
   ```
   This starts Postgres (with the schema applied automatically on first
   boot) and the bot together. Leave it running.

5. **Load some accounts.** In a second terminal, add your accounts (name,
   plan, seats, renewal date, owner — see
   [`data-seed/accounts.json`](data-seed/accounts.json) for the shape) and
   seed them in:
   ```bash
   docker compose run --rm app npm run seed
   ```
   The seed script is idempotent — re-run it any time your account list
   changes.

6. Ask `@Bell how is <account name> doing?` in Slack.

## Local development (without Docker)

Requires Node 22+ and a Postgres instance with the `pgvector` extension
available.

```bash
cd app
npm install
cp .env.example .env   # fill in the values as above; point DATABASE_URL
                        # at your local Postgres
psql "$DATABASE_URL" -f ../db/schema.sql
npm run seed:dev
npm run dev             # watches src/ and restarts on change
```

Other useful commands, run from `app/`:

| Command          | What it does                                   |
|------------------|-------------------------------------------------|
| `npm run build`  | Type-checks and compiles to `dist/`              |
| `npm start`      | Runs the compiled bot (`dist/index.js`)          |
| `npm test`       | Runs the test suite (health-scoring logic, etc.) |
| `npm run seed`   | Loads/updates accounts from the compiled build   |

## Configuration reference

All variables live in `app/.env` (see `app/.env.example`):

| Variable                | Required | Description |
|--------------------------|----------|-------------|
| `SLACK_BOT_TOKEN`        | yes | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET`   | yes | Verifies requests are from Slack |
| `SLACK_APP_TOKEN`        | yes | App-level token for Socket Mode (`xapp-...`) |
| `POSTHOG_API_KEY`        | yes | Personal API key with query read access |
| `POSTHOG_PROJECT_ID`     | yes | Your PostHog project ID |
| `POSTHOG_HOST`           | no  | Defaults to `https://eu.posthog.com` |
| `DATABASE_URL`           | yes | Postgres connection string |
| `PORT`                   | no  | Defaults to `3000` (health-check port; the bot itself runs over Socket Mode, not HTTP) |

Startup fails fast with a clear message listing anything missing, rather than
failing partway through handling a Slack event.

## Data seeding for a demo/test environment

[`data-seed/`](data-seed/) has a Python pipeline that synthesizes a realistic
population of accounts and usage history (including accounts on a slow
decline or a sudden cliff) directly into PostHog, useful for trying Bellwether
out without wiring up real product analytics. See
[`data-seed/schema.md`](data-seed/schema.md) for details.

## License

[MIT](LICENSE)
