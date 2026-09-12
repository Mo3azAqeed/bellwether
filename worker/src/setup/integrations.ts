import { exchangeServiceAccountToken } from "../connectors/google-meet.js";

export interface IntegrationField {
  key: string;
  label: string;
  placeholder?: string;
  type?: "text" | "password";
}

export interface TestResult {
  ok: boolean;
  message: string;
}

export interface Integration {
  id: string;
  name: string;
  icon: string;
  category: "usage" | "context" | "generation" | "bot";
  description: string;
  instructions: string;
  fields: IntegrationField[];
  /** Undefined for integrations with nothing testable via a live API call
   * (e.g. a webhook secret that's never used to make an outbound request) —
   * the UI saves directly instead of gating on a test. */
  test?: (values: Record<string, string>) => Promise<TestResult>;
}

async function ok(message: string): Promise<TestResult> {
  return { ok: true, message };
}
async function fail(message: string): Promise<TestResult> {
  return { ok: false, message };
}

/** Reads the response body into the failure message rather than just the
 * status code — the difference between "the provider says this key is
 * invalid" and "something in between (a proxy, a firewall, an outage)
 * never reached the provider at all" is exactly the body text, and a
 * bare status code hides it. */
async function failFromResponse(label: string, resp: Response): Promise<TestResult> {
  const body = await resp.text();
  return fail(`${label} (HTTP ${resp.status}): ${body.slice(0, 200)}`);
}

export const INTEGRATIONS: Integration[] = [
  {
    id: "posthog",
    name: "PostHog",
    icon: "📊",
    category: "usage",
    description: "Product usage data — powers the health-tier calculation.",
    instructions: "PostHog → Settings → Personal API Keys → create one with query read access. Project ID is under Settings → Project.",
    fields: [
      { key: "POSTHOG_API_KEY", label: "API key", type: "password" },
      { key: "POSTHOG_PROJECT_ID", label: "Project ID" },
      { key: "POSTHOG_HOST", label: "Host (optional, defaults to eu.posthog.com)" },
    ],
    test: async (v) => {
      const host = v.POSTHOG_HOST || "https://eu.posthog.com";
      const resp = await fetch(`${host}/api/projects/${v.POSTHOG_PROJECT_ID}/query/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${v.POSTHOG_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: "SELECT 1" } }),
      });
      return resp.ok ? ok("Connected.") : failFromResponse("PostHog rejected this", resp);
    },
  },
  {
    id: "mixpanel",
    name: "Mixpanel",
    icon: "📈",
    category: "usage",
    description: "Alternative to PostHog for usage data — use one or the other (set via USAGE_PROVIDER).",
    instructions: "Mixpanel → Organization Settings → Service Accounts → create one with query access.",
    fields: [
      { key: "MIXPANEL_PROJECT_ID", label: "Project ID" },
      { key: "MIXPANEL_SERVICE_ACCOUNT_USERNAME", label: "Service account username" },
      { key: "MIXPANEL_SERVICE_ACCOUNT_SECRET", label: "Service account secret", type: "password" },
      { key: "MIXPANEL_HOST", label: "Host (optional; eu.mixpanel.com for EU projects)" },
    ],
    test: async (v) => {
      const host = v.MIXPANEL_HOST || "https://mixpanel.com";
      const resp = await fetch(`${host}/api/query/jql`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${v.MIXPANEL_SERVICE_ACCOUNT_USERNAME}:${v.MIXPANEL_SERVICE_ACCOUNT_SECRET}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ project_id: v.MIXPANEL_PROJECT_ID, script: "function main(){return [];}" }),
      });
      return resp.ok ? ok("Connected.") : failFromResponse("Mixpanel rejected this", resp);
    },
  },
  {
    id: "fireflies",
    name: "Fireflies",
    icon: "🎙️",
    category: "context",
    description: "Meeting transcripts, via webhook, near-real-time.",
    instructions:
      "Fireflies → Settings → Developer Settings → create an API key. Pick any webhook secret yourself (any string). After saving, add the webhook in Fireflies pointed at this Worker's /webhooks/fireflies?secret=<your secret>.",
    fields: [
      { key: "FIREFLIES_API_KEY", label: "API key", type: "password" },
      { key: "FIREFLIES_WEBHOOK_SECRET", label: "Webhook secret (any string you choose)" },
    ],
    test: async (v) => {
      const resp = await fetch("https://api.fireflies.ai/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${v.FIREFLIES_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ query: `query { transcripts(limit: 1) { id } }` }),
      });
      if (!resp.ok) return failFromResponse("Fireflies rejected this", resp);
      const json = await resp.json<{ errors?: unknown[] }>();
      return json.errors?.length ? fail(`Fireflies rejected this: ${JSON.stringify(json.errors).slice(0, 200)}`) : ok("Connected.");
    },
  },
  {
    id: "zoom",
    name: "Zoom",
    icon: "🎥",
    category: "context",
    description: "Meeting transcripts, via webhook, near-real-time.",
    instructions:
      "Zoom Marketplace → Build App → Webhook-only app → Webhooks. Subscribe to \"All Recordings have completed transcription\", point the notification URL at this Worker's /webhooks/zoom, and copy the Secret Token below. There's no live check for this one — Zoom validates it on the first real webhook delivery.",
    fields: [{ key: "ZOOM_WEBHOOK_SECRET_TOKEN", label: "Secret Token", type: "password" }],
    // No test(): a webhook secret only verifies *inbound* Zoom requests, so
    // there's nothing to call outbound to validate it.
  },
  {
    id: "google_meet",
    name: "Google Meet",
    icon: "📹",
    category: "context",
    description: "Meeting transcripts, nightly backfill (Workspace only).",
    instructions:
      "Needs a Google Cloud service account with Workspace domain-wide delegation, scoped to meetings.space.readonly. Paste the client_email and private_key from its downloaded key, plus a Workspace user's email to impersonate.",
    fields: [
      { key: "GOOGLE_SERVICE_ACCOUNT_EMAIL", label: "Service account email" },
      { key: "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", label: "Private key (PEM)", type: "password" },
      { key: "GOOGLE_WORKSPACE_IMPERSONATE_EMAIL", label: "Workspace user to impersonate" },
    ],
    test: async (v) => {
      try {
        await exchangeServiceAccountToken({
          email: v.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          privateKey: v.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
          impersonateEmail: v.GOOGLE_WORKSPACE_IMPERSONATE_EMAIL,
        });
        return ok("Connected — obtained an access token.");
      } catch (err) {
        return fail(`Google rejected this — ${(err as Error).message}`);
      }
    },
  },
  {
    id: "intercom",
    name: "Intercom",
    icon: "💬",
    category: "context",
    description: "Support conversations, via webhook, near-real-time.",
    instructions:
      "Intercom Developer Hub → your app → Authentication for an access token, and Basic Information for the Client Secret. After saving, subscribe the app's Webhooks to conversation.admin.closed pointed at this Worker's /webhooks/intercom.",
    fields: [
      { key: "INTERCOM_ACCESS_TOKEN", label: "Access token", type: "password" },
      { key: "INTERCOM_CLIENT_SECRET", label: "Client secret", type: "password" },
    ],
    test: async (v) => {
      const resp = await fetch("https://api.intercom.io/me", { headers: { Authorization: `Bearer ${v.INTERCOM_ACCESS_TOKEN}` } });
      return resp.ok ? ok("Connected.") : failFromResponse("Intercom rejected this", resp);
    },
  },
  {
    id: "zendesk",
    name: "Zendesk",
    icon: "🎫",
    category: "context",
    description: "Support tickets, via webhook, near-real-time.",
    instructions:
      "Zendesk Admin Center → Apps and integrations → APIs → Zendesk API → enable token access, then Add API token. After saving, create a Trigger on \"Status changed to Solved\" with action \"Notify webhook\" pointed at this Worker's /webhooks/zendesk?secret=<your secret>, body { \"ticketId\": \"{{ticket.id}}\" }.",
    fields: [
      { key: "ZENDESK_SUBDOMAIN", label: "Subdomain (the part before .zendesk.com)" },
      { key: "ZENDESK_EMAIL", label: "Agent/admin email the token belongs to" },
      { key: "ZENDESK_API_TOKEN", label: "API token", type: "password" },
      { key: "ZENDESK_WEBHOOK_SECRET", label: "Webhook secret (any string you choose)" },
    ],
    test: async (v) => {
      const resp = await fetch(`https://${v.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/me.json`, {
        headers: { Authorization: `Basic ${btoa(`${v.ZENDESK_EMAIL}/token:${v.ZENDESK_API_TOKEN}`)}` },
      });
      return resp.ok ? ok("Connected.") : failFromResponse("Zendesk rejected this", resp);
    },
  },
  {
    id: "hubspot",
    name: "HubSpot",
    icon: "🧡",
    category: "context",
    description: "CRM notes (calls, meeting logs) — nightly backfill.",
    instructions: "HubSpot → Settings → Integrations → Private Apps → create one with crm.objects.notes.read and crm.objects.companies.read scopes.",
    fields: [{ key: "HUBSPOT_ACCESS_TOKEN", label: "Private app access token", type: "password" }],
    test: async (v) => {
      const resp = await fetch("https://api.hubapi.com/crm/v3/objects/companies?limit=1", {
        headers: { Authorization: `Bearer ${v.HUBSPOT_ACCESS_TOKEN}` },
      });
      return resp.ok ? ok("Connected.") : failFromResponse("HubSpot rejected this", resp);
    },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    icon: "✳️",
    category: "generation",
    description: "Better \"Why?\" answers than the free default (Workers AI). Small per-call cost.",
    instructions: "console.anthropic.com → API Keys → create one.",
    fields: [{ key: "ANTHROPIC_API_KEY", label: "API key", type: "password" }],
    test: async (v) => {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": v.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
      return resp.ok ? ok("Connected (this test made one tiny real request).") : failFromResponse("Anthropic rejected this", resp);
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "🔀",
    category: "generation",
    description: "One key, choice of model (including free ones) for \"Why?\" answers — used if Anthropic isn't set.",
    instructions: "openrouter.ai/keys → create a key. Model defaults to a cheap Llama; browse openrouter.ai/models to pick another.",
    fields: [
      { key: "OPENROUTER_API_KEY", label: "API key", type: "password" },
      { key: "OPENROUTER_MODEL", label: "Model (optional)" },
    ],
    test: async (v) => {
      const resp = await fetch("https://openrouter.ai/api/v1/auth/key", { headers: { Authorization: `Bearer ${v.OPENROUTER_API_KEY}` } });
      return resp.ok ? ok("Connected.") : failFromResponse("OpenRouter rejected this", resp);
    },
  },
  {
    id: "microsoft_teams",
    name: "Microsoft Teams",
    icon: "🟦",
    category: "bot",
    description: "The same @Bell-style bot as Slack, for Teams instead — health cards, \"Why?\" answers, buttons.",
    instructions:
      "Register an Azure Bot resource (portal.azure.com → create a resource → \"Azure Bot\") with messaging endpoint https://<your-worker>/api/messages. Copy its Application (client) ID and create a client secret under the linked Azure AD app registration's \"Certificates & secrets\". Then add the Teams channel under the bot resource's \"Channels\".",
    fields: [
      { key: "MICROSOFT_APP_ID", label: "Microsoft App ID" },
      { key: "MICROSOFT_APP_PASSWORD", label: "Microsoft App Password (client secret)", type: "password" },
    ],
    test: async (v) => {
      const resp = await fetch("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: v.MICROSOFT_APP_ID,
          client_secret: v.MICROSOFT_APP_PASSWORD,
          scope: "https://api.botframework.com/.default",
        }),
      });
      return resp.ok ? ok("Connected — obtained an access token.") : failFromResponse("Microsoft rejected this", resp);
    },
  },
];

export function findIntegration(id: string): Integration | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}
