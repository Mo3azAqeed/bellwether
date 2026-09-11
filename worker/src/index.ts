import type { Env } from "./env.js";
import { verifySlackRequest } from "./slack/verify.js";
import { handleAppMention, handleBlockAction, handleViewSubmission } from "./slack/handlers.js";
import { ingestDocument, type IngestInput } from "./rag/ingest.js";
import { allDbAccounts, recordHealthSnapshot, getLatestSnapshot } from "./db.js";
import { computeHealth, type HealthSnapshot } from "./baseline.js";
import { ingestFirefliesTranscript, backfillRecentFireflies } from "./connectors/fireflies.js";
import { handleZoomUrlValidation, verifyZoomSignature, ingestZoomTranscript } from "./connectors/zoom.js";
import { backfillRecentGoogleMeet } from "./connectors/google-meet.js";
import { verifyIntercomSignature, ingestIntercomConversation } from "./connectors/intercom.js";
import { ingestZendeskTicket } from "./connectors/zendesk.js";
import { backfillRecentHubSpot } from "./connectors/hubspot.js";
import { getSetting } from "./settings.js";
import { maybeAlert } from "./alerts.js";
import { claimSyncIfDue } from "./sync-schedule.js";
import { handleSetupPage, handleSetupStatus, handleTestAndSave, handleSkip, handleSetFrequency, handleSetAlertsChannel } from "./setup/handlers.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A malformed body should get a clean 400, not an uncaught exception —
 * matters most for handleZoomWebhook, where Zoom's unsigned CRC handshake
 * means this runs before any secret/signature check, so it's reachable by
 * anyone, not just holders of a valid webhook secret. */
function safeJsonParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function handleSlackEvents(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rawBody = await req.text();
  const ok = await verifySlackRequest(
    env.SLACK_SIGNING_SECRET,
    req.headers.get("x-slack-request-timestamp"),
    req.headers.get("x-slack-signature"),
    rawBody
  );
  if (!ok) return new Response("invalid signature", { status: 401 });

  const payload = safeJsonParse<Record<string, unknown>>(rawBody);
  if (!payload) return json({ error: "invalid JSON body" }, 400);

  if (payload.type === "url_verification") {
    return json({ challenge: payload.challenge });
  }

  if (payload.type === "event_callback") {
    const event = payload.event as { type: string; text?: string; channel: string; ts: string };
    if (event.type === "app_mention") {
      // Slack expects a response within 3s and retries on timeout; do the
      // actual work in the background via waitUntil so we can return
      // immediately without risking a duplicate retry mid-reply. Each
      // handler already gives the user a Slack-visible error on failure
      // (see slack/handlers.ts) — this .catch is just so a bug that slips
      // past that still logs cleanly instead of showing as "Uncaught".
      ctx.waitUntil(handleAppMention(env, event).catch((err) => console.error("handleAppMention failed", err)));
    }
  }

  return json({ ok: true });
}

async function handleSlackInteractions(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rawBody = await req.text();
  const ok = await verifySlackRequest(
    env.SLACK_SIGNING_SECRET,
    req.headers.get("x-slack-request-timestamp"),
    req.headers.get("x-slack-signature"),
    rawBody
  );
  if (!ok) return new Response("invalid signature", { status: 401 });

  const params = new URLSearchParams(rawBody);
  const payload = safeJsonParse<Record<string, unknown>>(params.get("payload") ?? "{}");
  if (!payload) return json({ error: "invalid JSON body" }, 400);

  if (payload.type === "block_actions") {
    ctx.waitUntil(handleBlockAction(env, payload).catch((err) => console.error("handleBlockAction failed", err)));
    return json({ ok: true });
  }

  if (payload.type === "view_submission") {
    ctx.waitUntil(handleViewSubmission(env, payload).catch((err) => console.error("handleViewSubmission failed", err)));
    return json({ response_action: "clear" });
  }

  return json({ ok: true });
}

async function handleIngest(req: Request, env: Env): Promise<Response> {
  const ingestKey = await getSetting(env, "INGEST_API_KEY");
  if (!ingestKey) {
    return json({ error: "Ingestion is disabled: set INGEST_API_KEY to enable POST /ingest." }, 501);
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${ingestKey}`) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: IngestInput;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.accountId || !body.source || !body.text) {
    return json({ error: "accountId, source, and text are required" }, 400);
  }

  const result = await ingestDocument(env, body);
  return json(result);
}

async function handleFirefliesWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const [apiKey, webhookSecret] = await Promise.all([getSetting(env, "FIREFLIES_API_KEY"), getSetting(env, "FIREFLIES_WEBHOOK_SECRET")]);
  if (!apiKey || !webhookSecret) {
    return json({ error: "Fireflies connector is disabled: set FIREFLIES_API_KEY and FIREFLIES_WEBHOOK_SECRET." }, 501);
  }

  // Fireflies' webhook config UI doesn't support custom headers, so the
  // shared secret is checked as a query param on the URL you register with
  // them (`.../webhooks/fireflies?secret=...`) — an `X-Webhook-Secret`
  // header is also accepted in case that changes.
  const url = new URL(req.url);
  const providedSecret = req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  if (providedSecret !== webhookSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = safeJsonParse<{ meetingId?: string; eventType?: string }>(await req.text());
  if (!body) return json({ error: "invalid JSON body" }, 400);
  if (body.eventType && body.eventType !== "Transcription completed") {
    return json({ ok: true, skipped: "not a completion event" });
  }
  if (!body.meetingId) {
    return json({ error: "missing meetingId" }, 400);
  }

  ctx.waitUntil(
    ingestFirefliesTranscript(env, body.meetingId).catch((err) =>
      console.error(`fireflies webhook ingest failed for ${body.meetingId}`, err)
    )
  );
  return json({ ok: true });
}

async function handleZoomWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secretToken = await getSetting(env, "ZOOM_WEBHOOK_SECRET_TOKEN");
  if (!secretToken) {
    return json({ error: "Zoom connector is disabled: set ZOOM_WEBHOOK_SECRET_TOKEN." }, 501);
  }

  const rawBody = await req.text();
  const parsed = safeJsonParse<{ event: string; payload: Record<string, unknown> }>(rawBody);
  if (!parsed) return json({ error: "invalid JSON body" }, 400);

  // Zoom's one-time handshake when you register the endpoint URL — must be
  // answered correctly before Zoom will deliver real events, and isn't
  // itself signed the way real events are.
  if (parsed.event === "endpoint.url_validation") {
    const plainToken = (parsed.payload as { plainToken: string }).plainToken;
    return json(await handleZoomUrlValidation(secretToken, plainToken));
  }

  const ok = await verifyZoomSignature(
    secretToken,
    req.headers.get("x-zm-request-timestamp"),
    req.headers.get("x-zm-signature"),
    rawBody
  );
  if (!ok) return new Response("invalid signature", { status: 401 });

  if (parsed.event === "recording.transcript_completed") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.waitUntil(ingestZoomTranscript(env, parsed as any).catch((err) => console.error("zoom webhook ingest failed", err)));
  }
  return json({ ok: true });
}

async function handleIntercomWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const [accessToken, clientSecret] = await Promise.all([getSetting(env, "INTERCOM_ACCESS_TOKEN"), getSetting(env, "INTERCOM_CLIENT_SECRET")]);
  if (!accessToken || !clientSecret) {
    return json({ error: "Intercom connector is disabled: set INTERCOM_ACCESS_TOKEN and INTERCOM_CLIENT_SECRET." }, 501);
  }

  const rawBody = await req.text();
  const ok = await verifyIntercomSignature(clientSecret, req.headers.get("x-hub-signature"), rawBody);
  if (!ok) return new Response("invalid signature", { status: 401 });

  const payload = safeJsonParse<{ topic?: string; data?: { item?: { id?: string } } }>(rawBody);
  if (!payload) return json({ error: "invalid JSON body" }, 400);
  const conversationId = payload.data?.item?.id;
  if (payload.topic?.startsWith("conversation.") && conversationId) {
    ctx.waitUntil(
      ingestIntercomConversation(env, conversationId).catch((err) =>
        console.error(`intercom webhook ingest failed for ${conversationId}`, err)
      )
    );
  }
  return json({ ok: true });
}

async function handleZendeskWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const webhookSecret = await getSetting(env, "ZENDESK_WEBHOOK_SECRET");
  if (!webhookSecret) {
    return json({ error: "Zendesk connector is disabled: set ZENDESK_WEBHOOK_SECRET." }, 501);
  }

  const url = new URL(req.url);
  const providedSecret = req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  if (providedSecret !== webhookSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = safeJsonParse<{ ticketId?: string | number }>(await req.text());
  if (!body?.ticketId) return json({ error: "missing ticketId" }, 400);

  ctx.waitUntil(
    ingestZendeskTicket(env, body.ticketId).catch((err) => console.error(`zendesk webhook ingest failed for ${body.ticketId}`, err))
  );
  return json({ ok: true });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/slack/events") {
      return handleSlackEvents(req, env, ctx);
    }
    if (req.method === "POST" && url.pathname === "/slack/interactions") {
      return handleSlackInteractions(req, env, ctx);
    }
    if (req.method === "POST" && url.pathname === "/ingest") {
      return handleIngest(req, env);
    }
    if (req.method === "POST" && url.pathname === "/webhooks/fireflies") {
      return handleFirefliesWebhook(req, env, ctx);
    }
    if (req.method === "POST" && url.pathname === "/webhooks/zoom") {
      return handleZoomWebhook(req, env, ctx);
    }
    if (req.method === "POST" && url.pathname === "/webhooks/intercom") {
      return handleIntercomWebhook(req, env, ctx);
    }
    if (req.method === "POST" && url.pathname === "/webhooks/zendesk") {
      return handleZendeskWebhook(req, env, ctx);
    }
    if (req.method === "GET" && url.pathname === "/setup") {
      return handleSetupPage(env);
    }
    if (req.method === "GET" && url.pathname === "/setup/api/status") {
      return handleSetupStatus(req, env);
    }
    if (req.method === "POST" && url.pathname === "/setup/api/test-and-save") {
      return handleTestAndSave(req, env);
    }
    if (req.method === "POST" && url.pathname === "/setup/api/skip") {
      return handleSkip(req, env);
    }
    if (req.method === "POST" && url.pathname === "/setup/api/frequency") {
      return handleSetFrequency(req, env);
    }
    if (req.method === "POST" && url.pathname === "/setup/api/alerts-channel") {
      return handleSetAlertsChannel(req, env);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },

  /** Fires every 4 hours (see wrangler.jsonc `triggers.crons`) but only
   * does the actual sync work when it's due per the user's chosen
   * frequency (src/sync-schedule.ts, set via the /setup UI) — so the trigger
   * itself stays fixed at the finest interval offered, and "sync every 24h"
   * just means most firings are a no-op D1 read. When due: recomputes every
   * account's usage tier (alerting on any tier change) so history
   * accumulates even for accounts nobody asked `@Bell` about, and backfills
   * anything a connector's webhook delivery missed. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const due = await claimSyncIfDue(env);
    if (!due) return;

    const accounts = await allDbAccounts(env.DB);
    for (const account of accounts) {
      try {
        const previous = await getLatestSnapshot(env.DB, account.account_id);
        const health = await computeHealth(env, account);
        await recordHealthSnapshot(env.DB, account.account_id, health.avgActiveSeats, health.baselineDeltaPct, health.tier);
        await maybeAlert(env, account, previous?.tier as HealthSnapshot["tier"] | undefined, health);
      } catch (err) {
        console.error(`nightly sweep failed for ${account.account_id}`, err);
      }
    }

    try {
      await backfillRecentFireflies(env);
    } catch (err) {
      console.error("fireflies backfill failed", err);
    }

    try {
      await backfillRecentGoogleMeet(env);
    } catch (err) {
      console.error("google meet backfill failed", err);
    }

    try {
      await backfillRecentHubSpot(env);
    } catch (err) {
      console.error("hubspot backfill failed", err);
    }
  },
} satisfies ExportedHandler<Env>;
