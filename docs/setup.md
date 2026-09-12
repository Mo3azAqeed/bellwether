# Connect your tools

Two ways in, same code behind both: a page the Worker serves itself, or a terminal menu. Every credential is tested against the real service before it's saved, and everything saves to your own database — no redeploy.

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
frequency** (see [How data stays fresh](connectors.md#how-data-stays-fresh)) — both save
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
an Azure Bot resource) — that's step 6 in [Deploy](deploy.md), not something a
credential-only CLI can do for you.
