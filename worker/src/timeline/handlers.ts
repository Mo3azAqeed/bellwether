/** Routes behind the account timeline: the page itself, the account list
 * that fills its picker, and the events for one account.
 *
 * Gated by SETUP_ADMIN_TOKEN, the same credential as the setup wizard. That
 * is a deliberate first version and a real limitation: this page shows
 * verbatim customer conversations, so it wants per-user auth, and an admin
 * token shared with whoever configures the deployment is not that. It fails
 * closed when the token is unset, and it is documented as the gap it is. */

import type { Env } from "../env.js";
import { allDbAccounts } from "../db.js";
import { buildTimeline } from "./data.js";
import { renderTimelinePage } from "./page.js";

/** True when the request came from the machine the Worker is running on —
 * i.e. `wrangler dev` on someone's laptop, or a local container.
 *
 * On a deployed Worker this is never true. Cloudflare terminates the public
 * request itself, so the URL it hands the handler carries the real hostname
 * (`bellwether.you.workers.dev`, your custom domain); a client cannot make
 * it say "localhost" by sending a Host header, because the hostname is
 * resolved before the script runs. So this can't be spoofed into opening a
 * production deployment. */
export function isLocalRequest(req: Request): boolean {
  try {
    const host = new URL(req.url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

/** Running locally, you are already the person who owns the database — you
 * have the file on disk. A token prompt there protects nothing and just
 * makes the page annoying to open from a terminal. Deployed, it is required. */
function isAuthorized(req: Request, env: Env): boolean {
  if (isLocalRequest(req)) return true;
  if (!env.SETUP_ADMIN_TOKEN) return false;
  return req.headers.get("authorization") === `Bearer ${env.SETUP_ADMIN_TOKEN}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function handleTimelinePage(req: Request, env: Env): Response {
  if (!env.SETUP_ADMIN_TOKEN && !isLocalRequest(req)) {
    return new Response(
      "The timeline is disabled: set SETUP_ADMIN_TOKEN (wrangler secret put SETUP_ADMIN_TOKEN) before using it.",
      { status: 501 }
    );
  }
  return new Response(renderTimelinePage(), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleTimelineAccounts(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env)) return json({ error: "unauthorized" }, 401);
  const accounts = await allDbAccounts(env.DB);
  return json(accounts.map((a) => ({ accountId: a.account_id, name: a.name })));
}

export async function handleTimelineEvents(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env)) return json({ error: "unauthorized" }, 401);

  const accountId = new URL(req.url).searchParams.get("account")?.trim();
  if (!accountId) return json({ error: "account is required" }, 400);

  const timeline = await buildTimeline(env, accountId);
  if (!timeline) return json({ error: "no such account" }, 404);

  return new Response(JSON.stringify(timeline), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
