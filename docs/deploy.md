# Deploy Bellwether

About twenty minutes end to end, most of it waiting on Slack's and Azure's own consoles. Prefer to have a coding agent do it for you? [`AGENTS.md`](../AGENTS.md) is a playbook written for exactly that.

You'll need a [Cloudflare account](https://dash.cloudflare.com/sign-up)
(free to create — the $5/mo Workers Paid plan is only required if you turn
on the RAG features), a Slack workspace and/or a Microsoft 365 tenant you can
register a bot in (connect either or both), and a [PostHog](https://posthog.com)
project receiving `app_opened` events grouped by account (see the schema doc
linked below).

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
   [`data-seed/accounts.json`](../data-seed/accounts.json), then:
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
   [Configuration](configuration.md) for the full list of env var names
   either path uses.

5. **Deploy:**
   ```bash
   npm run deploy
   ```
   Wrangler prints your Worker's URL (`https://bellwether.<you>.workers.dev`).

6. **Create the Slack app and/or the Teams bot** (whichever you're using):

   **Slack** — open [`worker/slack-manifest.json`](../worker/slack-manifest.json),
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
   [Connect your tools](setup.md). Or use `npm run setup` instead — see
   [CLI setup](setup.md#cli-setup).

8. Ask `@Bell how is <account name> doing?` in Slack, or just message the
   bot directly in Teams.
