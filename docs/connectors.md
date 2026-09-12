# Context sources

Health tiers tell you *something changed*. These are what let Bellwether answer *why* — the call transcripts, support tickets and CRM notes it retrieves from. Configure them through the [setup wizard](setup.md), or by hand below.

RAG needs something to retrieve. Six built-in connectors (configure them
through the [setup wizard](setup.md), or by hand below), plus a
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

**Salesforce** (logged calls, emails and meetings — `Task` records against an
Account; nightly backfill):
```bash
npx wrangler secret put SALESFORCE_INSTANCE_URL    # https://acme.my.salesforce.com
npx wrangler secret put SALESFORCE_CLIENT_ID
npx wrangler secret put SALESFORCE_CLIENT_SECRET
```
In Salesforce: Setup → **External Client Apps** → create one, enable OAuth
with **Enable Client Credentials Flow** and a run-as user whose permissions
decide what this can see, then copy the consumer key and secret. (Older orgs
use Connected Apps; new Connected App creation is disabled by default from
Spring '26 onward.) Accounts are matched to yours by the Account's
**Website** field, so populate it — or add the domain to `account_domains`
below. Salesforce's newer "enhanced notes" (`ContentNote`) are deliberately
not read: they need a `ContentDocumentLink` join plus base64 decoding and
follow separate content sharing rules. Open an issue if your CS context
lives there.

**Attio** (notes written on company records; nightly backfill):
```bash
npx wrangler secret put ATTIO_API_KEY   # Workspace settings → Developers → access token, read on Records + Notes
```
Only notes whose parent is a *company* are ingested — Attio lets you attach
notes to people and deals too, but those don't map onto an account without
guessing, and a wrong guess files one customer's context under another's.

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
  isn't on the frequency schedule above. Google Meet, HubSpot, Salesforce
  and Attio are backfill-only (same schedule as usage numbers above —
  real-time would need infrastructure outside Cloudflare for Meet, and a
  public-app webhook subscription for the CRMs). Each due run also re-checks
  the last 2 days of Fireflies transcripts as a safety net for any webhook
  delivery that failed — so the worst case for any source is one sync
  interval, not "silently lost forever."

**The honest limits of that**, since "reliable sync" deserves specifics
rather than a promise:

- Every backfill re-reads a *window*, not everything since last time:
  Salesforce asks for `Task` records modified in the last 2 days, Attio
  pages back through the 250 most recent notes, HubSpot and Google Meet
  look back 2 days. Anything ingested twice is deduped by source id, so
  overlapping runs are free — the failure mode to know about is the other
  direction. If the Worker can't run for longer than that window (a
  Cloudflare outage, a revoked credential nobody noticed), records older
  than the window are not picked up on the next successful run.
- Practically: with the default 24h sync and a 2-day lookback you have a 2x
  safety margin, and each source is independent — one CRM's expired token
  doesn't stop the others (each backfill is wrapped in its own try/catch and
  logs rather than aborting the run).
- If you need a genuinely gapless CRM history, backfill the range you care
  about once through `POST /ingest`, which takes arbitrary text and dates —
  the scheduled connectors are built to keep an already-current picture
  current, not to reconstruct years of history.
- **Alerts**: if you set an alerts channel in the wizard, every due sync run
  compares each account's new tier against its previous one and posts to
  Slack on any change (up or down) — there's an example of that message
  in the [README](../README.md).
