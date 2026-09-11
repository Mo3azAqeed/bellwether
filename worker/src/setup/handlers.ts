import type { Env } from "../env.js";
import { getSetting, setSetting, deleteSetting } from "../settings.js";
import { getSyncFrequencyHours, VALID_FREQUENCIES_HOURS } from "../sync-schedule.js";
import { INTEGRATIONS, findIntegration } from "./integrations.js";
import { renderSetupPage } from "./page.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function safeReadJson<T>(req: Request): Promise<T | undefined> {
  try {
    return await req.json<T>();
  } catch {
    return undefined;
  }
}

/** SETUP_ADMIN_TOKEN is deliberately never read via getSetting/D1 — it's
 * the one credential that has to exist before the UI can be trusted at
 * all, so it stays a Workers secret set before first deploy, not something
 * the UI can view or change about itself. */
function isAuthorized(req: Request, env: Env): boolean {
  if (!env.SETUP_ADMIN_TOKEN) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${env.SETUP_ADMIN_TOKEN}`;
}

export function handleSetupPage(env: Env): Response {
  if (!env.SETUP_ADMIN_TOKEN) {
    return new Response(
      "The setup UI is disabled: set SETUP_ADMIN_TOKEN (wrangler secret put SETUP_ADMIN_TOKEN) before using it.",
      { status: 501 }
    );
  }
  const clientIntegrations = INTEGRATIONS.map((i) => ({
    id: i.id,
    name: i.name,
    icon: i.icon,
    category: i.category,
    description: i.description,
    instructions: i.instructions,
    fields: i.fields,
    hasTest: !!i.test,
  }));
  return new Response(renderSetupPage(clientIntegrations), { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function handleSetupStatus(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env)) return json({ error: "unauthorized" }, 401);

  const integrations = await Promise.all(
    INTEGRATIONS.map(async (integration) => {
      const values = await Promise.all(integration.fields.map((f) => getSetting(env, f.key)));
      const connected = values.some((v) => !!v); // any field set counts as "started"
      const skipped = (await getSetting(env, `SKIPPED_${integration.id}`)) === "true";
      return { id: integration.id, connected, skipped };
    })
  );

  const [syncFrequencyHours, alertsChannel] = await Promise.all([
    getSyncFrequencyHours(env),
    getSetting(env, "SLACK_ALERTS_CHANNEL"),
  ]);

  return json({ integrations, syncFrequencyHours, alertsChannel: alertsChannel ?? null });
}

export async function handleTestAndSave(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env)) return json({ error: "unauthorized" }, 401);

  const body = await safeReadJson<{ integrationId: string; values: Record<string, string> }>(req);
  if (!body) return json({ error: "invalid JSON body" }, 400);
  const integration = findIntegration(body.integrationId);
  if (!integration) return json({ error: "unknown integration" }, 404);

  if (integration.test) {
    let result;
    try {
      result = await integration.test(body.values);
    } catch (err) {
      return json({ ok: false, message: `Test request failed: ${(err as Error).message}` });
    }
    if (!result.ok) return json(result);
  }

  for (const field of integration.fields) {
    const value = body.values[field.key];
    if (value) await setSetting(env, field.key, value);
  }
  await deleteSetting(env, `SKIPPED_${integration.id}`);

  return json({ ok: true, message: integration.test ? "Connected and saved." : "Saved." });
}

export async function handleSkip(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env)) return json({ error: "unauthorized" }, 401);
  const body = await safeReadJson<{ integrationId: string }>(req);
  if (!body) return json({ error: "invalid JSON body" }, 400);
  if (!findIntegration(body.integrationId)) return json({ error: "unknown integration" }, 404);
  await setSetting(env, `SKIPPED_${body.integrationId}`, "true");
  return json({ ok: true });
}

export async function handleSetFrequency(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env)) return json({ error: "unauthorized" }, 401);
  const body = await safeReadJson<{ hours: number }>(req);
  if (!body || !(VALID_FREQUENCIES_HOURS as readonly number[]).includes(body.hours)) {
    return json({ error: `hours must be one of ${VALID_FREQUENCIES_HOURS.join(", ")}` }, 400);
  }
  await setSetting(env, "SYNC_FREQUENCY_HOURS", String(body.hours));
  return json({ ok: true });
}

export async function handleSetAlertsChannel(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env)) return json({ error: "unauthorized" }, 401);
  const body = await safeReadJson<{ channel: string }>(req);
  if (!body) return json({ error: "invalid JSON body" }, 400);
  if (body.channel) await setSetting(env, "SLACK_ALERTS_CHANNEL", body.channel);
  else await deleteSetting(env, "SLACK_ALERTS_CHANNEL");
  return json({ ok: true });
}
