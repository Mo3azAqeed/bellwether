# Agent instructions for this repo

This file is for AI coding agents (Claude Code, Cursor, Codex, OpenCode,
etc.) working in this repo — either helping develop it, or helping a human
deploy and set up their own instance of it. The full human-readable docs are
in [`README.md`](README.md); this file is the imperative, do-this-when
version for an agent.

## If a human asks you to deploy / install / set up Bellwether

Walk them through it the way `dbt init` walks someone through a new project:
run the mechanical steps yourself, and ask the human directly, in
conversation, for anything you can't know or do for them. Don't just paste
the README at them — actually run the commands and react to what happens.

Work through these phases in order. Stop and ask before moving to a phase
that depends on the previous one having actually succeeded.

### 1. Prerequisites

Ask which chat platform(s) they want: Slack, Microsoft Teams, or both. At
least one is required. Ask whether they already have a Cloudflare account
(free to create) and a PostHog or Mixpanel project receiving usage events —
if not, point them at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
and let them create one before continuing; you can't do this step for them.

### 2. Install and authenticate

```bash
cd worker
npm install
npx wrangler login
```

`wrangler login` opens a browser OAuth flow — the human has to click
through it themselves. Wait for them to confirm it succeeded before
continuing.

### 3. Create the database and vector index

```bash
npx wrangler d1 create bellwether
npx wrangler vectorize create bellwether-context --dimensions=768 --metric=cosine
```

`wrangler d1 create` prints a database ID — edit it into `wrangler.jsonc`
(`d1_databases[0].database_id`) yourself, don't ask the human to do it. Then:

```bash
npm run db:migrate:remote
```

### 4. Set the secrets required before first deploy

`SETUP_ADMIN_TOKEN` is always required. Generate a strong random string
yourself (e.g. `openssl rand -hex 24`) rather than asking the human to
invent one — this one never needs to be human-memorable, it's pasted into
the setup wizard once. Then, for whichever platform(s) they chose in step 1:

```bash
npx wrangler secret put SETUP_ADMIN_TOKEN   # you generate this value

# If using Slack — ask the human for these two (see step 6, they don't have
# them yet on a first run; come back to this after step 6):
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET

# If using Teams — same story, come back after step 6:
npx wrangler secret put MICROSOFT_APP_ID
npx wrangler secret put MICROSOFT_APP_PASSWORD
```

`wrangler secret put` prompts for the value on stdin interactively — when
you run it yourself, you will need to supply the value as input to that
prompt. If your shell tool can't pipe a value into an interactive prompt,
tell the human the exact command to run themselves and wait for them to
confirm it's done, rather than guessing or skipping it.

### 5. Deploy

```bash
npm run deploy
```

This prints the Worker's URL (`https://bellwether.<them>.workers.dev`).
Keep it — you need it for the next two steps.

### 6. Create the Slack app and/or Teams bot

This part is unavoidably a browser/portal flow for the human — do not try
to do it via shell commands.

**Slack**: tell them to open `worker/slack-manifest.json`, replace the two
`REPLACE-WITH-YOUR-WORKER` placeholders with the real Worker URL from step
5 (you can make this edit yourself), then go to
[api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From
an app manifest* and paste it in. After they install the app, they need to
give you two values back: the **Bot User OAuth Token** (`xoxb-...`, under
OAuth & Permissions) and the **Signing Secret** (under Basic Information).
Once you have both, go back and run the `wrangler secret put
SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` commands from step 4.

**Teams**: tell them to create an "Azure Bot" resource in the
[Azure Portal](https://portal.azure.com) with messaging endpoint
`https://<worker-url>/api/messages`, then give you the **Microsoft App ID**
and a **client secret** created under the app registration's Certificates &
secrets. Once you have both, run the `MICROSOFT_APP_ID` /
`MICROSOFT_APP_PASSWORD` secret commands from step 4.

### 7. Connect their data sources — the actual "which CRM, which tools" step

This is the part the human actually cares about. Don't send them to a
browser for this — you can do it directly. Ask, one at a time, conversationally:

1. "PostHog or Mixpanel for usage data?" — then ask for the credential that
   provider needs (PostHog: API key + project ID; Mixpanel: project ID +
   service account username/secret — see the Configuration table in
   `README.md` for exact field names).
2. "Any of these for the 'why is this account declining' feature: Fireflies,
   Zoom, Google Meet for call transcripts; Intercom or Zendesk for support;
   HubSpot for CRM notes?" Only ask about ones they're likely to actually
   use — don't read them the whole list mechanically.
3. For each one they want, write the value straight to their database —
   this is the same mechanism the `/setup` web wizard and `npm run setup`
   CLI both use, so it takes effect immediately, no redeploy:

   ```bash
   echo "INSERT INTO settings (key, value, updated_at) VALUES ('POSTHOG_API_KEY', 'phx_...', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;" \
     | npx wrangler d1 execute bellwether --remote
   ```

   (Swap the key and value per credential — the Configuration table in
   `README.md` lists every valid key.) Never print a secret value back to
   the human in chat once they've given it to you; just confirm it saved.

4. Populate `account_domains` so ingested context attaches to the right
   account:

   ```bash
   echo "INSERT INTO account_domains (domain, account_id) VALUES ('customer.com', 'acct-001');" \
     | npx wrangler d1 execute bellwether --remote
   ```

   Ask the human for their real account IDs/domains rather than guessing —
   if they haven't loaded any accounts yet, point them at the "Load your
   accounts" step in `README.md` first (`data-seed/accounts.json` shape,
   `npm run seed:sql`).

If any webhook-based connector (Fireflies, Zoom, Intercom, Zendesk) needs a
webhook registered on the provider's side, tell the human the exact URL and
what to subscribe to (see `README.md`'s per-connector instructions) — that
registration step happens on the provider's own site, not something you can
do for them.

### 8. Confirm it's alive

Ask them to try `@Bell how is <an account name> doing?` in Slack, or DM the
bot directly in Teams. If nothing responds, check `npx wrangler tail` for
errors before guessing.

### 9. Offer to connect it back to *this* coding session

Once deployed, Bellwether also exposes an MCP server (`POST /mcp`) so you —
or whichever coding agent the human is using — can query the same account
context without leaving the editor. Offer this as a final step, don't
assume they want it:

```bash
npx wrangler secret put MCP_ACCESS_TOKEN   # generate a strong random value
```

Then add it to whichever agent they're using — see the "MCP: use it from
your coding agent" section of `README.md` for the exact config snippet per
tool (Claude Code, Cursor, Codex CLI, OpenCode).

## Development conventions (working on Bellwether's own code)

- Every credential/config read in `worker/src/` goes through
  `getSetting`/`getSettings` (`worker/src/settings.ts`), never `env.X`
  directly — D1 is checked first, falling back to the Workers secret/var, so
  the wizard/CLI/agent-driven D1 writes above all take effect without a
  redeploy.
- Slack and Teams answer through the same platform-agnostic
  `worker/src/bot-logic.ts` — new "what does this question mean" logic goes
  there, not duplicated into `src/slack/` or `src/teams/`.
- `npm test` (vitest) and `npm run typecheck` before considering any change
  to `worker/` done. There's no CI here yet — you're the check.
- Don't add a new connector's credentials as `env.X` typed fields without
  also adding them to the `Env` interface in `worker/src/env.ts` and the
  Configuration table in `README.md`.
