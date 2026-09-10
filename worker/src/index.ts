import type { Env } from "./env.js";
import { verifySlackRequest } from "./slack/verify.js";
import { handleAppMention, handleBlockAction, handleViewSubmission } from "./slack/handlers.js";
import { ingestDocument, type IngestInput } from "./rag/ingest.js";
import { allDbAccounts, recordHealthSnapshot } from "./db.js";
import { computeHealth } from "./baseline.js";
import { ingestFirefliesTranscript, backfillRecentFireflies } from "./connectors/fireflies.js";
import { handleZoomUrlValidation, verifyZoomSignature, ingestZoomTranscript } from "./connectors/zoom.js";
import { backfillRecentGoogleMeet } from "./connectors/google-meet.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

  const payload = JSON.parse(rawBody) as Record<string, unknown>;

  if (payload.type === "url_verification") {
    return json({ challenge: payload.challenge });
  }

  if (payload.type === "event_callback") {
    const event = payload.event as { type: string; text?: string; channel: string; ts: string };
    if (event.type === "app_mention") {
      // Slack expects a response within 3s and retries on timeout; do the
      // actual work in the background via waitUntil so we can return
      // immediately without risking a duplicate retry mid-reply.
      ctx.waitUntil(handleAppMention(env, event));
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
  const payload = JSON.parse(params.get("payload") ?? "{}");

  if (payload.type === "block_actions") {
    ctx.waitUntil(handleBlockAction(env, payload));
    return json({ ok: true });
  }

  if (payload.type === "view_submission") {
    ctx.waitUntil(handleViewSubmission(env, payload));
    return json({ response_action: "clear" });
  }

  return json({ ok: true });
}

async function handleIngest(req: Request, env: Env): Promise<Response> {
  if (!env.INGEST_API_KEY) {
    return json({ error: "Ingestion is disabled: set INGEST_API_KEY to enable POST /ingest." }, 501);
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.INGEST_API_KEY}`) {
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
  if (!env.FIREFLIES_API_KEY || !env.FIREFLIES_WEBHOOK_SECRET) {
    return json({ error: "Fireflies connector is disabled: set FIREFLIES_API_KEY and FIREFLIES_WEBHOOK_SECRET." }, 501);
  }

  // Fireflies' webhook config UI doesn't support custom headers, so the
  // shared secret is checked as a query param on the URL you register with
  // them (`.../webhooks/fireflies?secret=...`) — an `X-Webhook-Secret`
  // header is also accepted in case that changes.
  const url = new URL(req.url);
  const providedSecret = req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  if (providedSecret !== env.FIREFLIES_WEBHOOK_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = await req.json<{ meetingId?: string; eventType?: string }>();
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
  if (!env.ZOOM_WEBHOOK_SECRET_TOKEN) {
    return json({ error: "Zoom connector is disabled: set ZOOM_WEBHOOK_SECRET_TOKEN." }, 501);
  }

  const rawBody = await req.text();
  const parsed = JSON.parse(rawBody) as { event: string; payload: Record<string, unknown> };

  // Zoom's one-time handshake when you register the endpoint URL — must be
  // answered correctly before Zoom will deliver real events, and isn't
  // itself signed the way real events are.
  if (parsed.event === "endpoint.url_validation") {
    const plainToken = (parsed.payload as { plainToken: string }).plainToken;
    return json(await handleZoomUrlValidation(env.ZOOM_WEBHOOK_SECRET_TOKEN, plainToken));
  }

  const ok = await verifyZoomSignature(
    env.ZOOM_WEBHOOK_SECRET_TOKEN,
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
    if (req.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },

  /** Nightly (see wrangler.jsonc `triggers.crons`): recomputes every
   * account's usage tier so history accumulates even for accounts nobody
   * asked `@Bell` about that day, and backfills any Fireflies transcripts
   * whose webhook delivery never arrived — the safety net under the
   * real-time webhook path, not the primary path itself. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const accounts = await allDbAccounts(env.DB);
    for (const account of accounts) {
      try {
        const health = await computeHealth(env, account);
        await recordHealthSnapshot(env.DB, account.account_id, health.avgActiveSeats, health.baselineDeltaPct, health.tier);
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
  },
} satisfies ExportedHandler<Env>;
