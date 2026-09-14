# Configuration reference

Every setting Bellwether reads, where it can be set, and whether you need it before your first deploy.

Every row below can be set either through the [setup wizard](setup.md)
(saved to D1) — or the [CLI](setup.md#cli-setup), which is the same thing — or as a
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
| `INTERCOM_APP_ID` | no | Not a credential — the workspace id in Intercom's URLs. Set it and every Intercom citation becomes a clickable link to the conversation |
| `HUBSPOT_PORTAL_ID` | no | Not a credential — the portal id in every `app.hubspot.com` URL. Set it and HubSpot citations link to the note |
| `HUBSPOT_ACCESS_TOKEN` | no | Enables the HubSpot connector |
| `SALESFORCE_INSTANCE_URL` / `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` | no | Enables the Salesforce connector (OAuth2 client credentials) |
| `ATTIO_API_KEY` | no | Enables the Attio connector |
| `SLACK_ALERTS_CHANNEL` | no | Slack channel ID alerts post to on a tier change; unset = alerting off |
| `SYNC_FREQUENCY_HOURS` | no | `4`, `8`, `12`, or `24` (default) — see [How data stays fresh](connectors.md#how-data-stays-fresh) |
