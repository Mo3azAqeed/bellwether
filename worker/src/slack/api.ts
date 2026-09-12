/** Minimal Slack Web API client — just the handful of methods this bot
 * needs. No SDK dependency; Workers can just `fetch` slack.com directly. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(botToken: string, method: string, payload: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  // Slack's API always replies 200 with {ok:false,error} even for auth
  // failures — but a proxy/outage in between can still hand back a
  // non-JSON body (an HTML error page, a plain-text block message), so
  // parse defensively rather than assuming resp.json() will succeed.
  const rawBody = await resp.text();
  let json: { ok: boolean; error?: string };
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new Error(`Slack API ${method} returned a non-JSON response (HTTP ${resp.status}): ${rawBody.slice(0, 200)}`);
  }
  if (!json.ok) {
    throw new Error(`Slack API ${method} failed: ${json.error ?? resp.status}`);
  }
  return json;
}

export function postMessage(
  botToken: string,
  args: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string }
) {
  return call(botToken, "chat.postMessage", args);
}

export function openView(botToken: string, args: { trigger_id: string; view: unknown }) {
  return call(botToken, "views.open", args);
}

/** Interaction payloads (buttons, view submissions) carry a `response_url`
 * that lets you reply without a bot token — simpler than chat.postMessage
 * for "update the message that triggered this". */
export async function respondToInteraction(
  responseUrl: string,
  body: { text?: string; blocks?: unknown[]; replace_original?: boolean }
) {
  const resp = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Slack response_url call failed: HTTP ${resp.status}`);
  }
}
