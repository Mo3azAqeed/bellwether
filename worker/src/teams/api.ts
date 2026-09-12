/** Sends messages back to Teams via the Bot Framework Connector API.
 * Outbound auth is a separate OAuth2 client-credentials grant from the
 * inbound JWT verification in verify.ts — the "channel" side and the "bot"
 * side authenticate to each other independently. */

import type { Env } from "../env.js";
import { getSettings } from "../settings.js";

const TOKEN_URL = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";

let cachedToken: { token: string; expiresAt: number } | undefined;

async function getAccessToken(appId: string, appPassword: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: appId,
      client_secret: appPassword,
      scope: "https://api.botframework.com/.default",
    }),
  });
  if (!resp.ok) throw new Error(`Bot Framework token exchange failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  const json = await resp.json<{ access_token: string; expires_in: number }>();
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.token;
}

export interface AdaptiveCardAttachment {
  contentType: "application/vnd.microsoft.card.adaptive";
  content: unknown;
}

/** Replies in the same conversation an incoming activity came from —
 * serviceUrl + conversation id together are how Bot Framework routes a
 * reply to the right channel/DM, there's no separate "channel id" concept
 * like Slack's. */
export async function replyToActivity(
  env: Env,
  incoming: { serviceUrl: string; conversation: { id: string }; id?: string },
  reply: { text: string; attachments?: AdaptiveCardAttachment[] }
): Promise<void> {
  const settings = await getSettings(env, ["MICROSOFT_APP_ID", "MICROSOFT_APP_PASSWORD"]);
  if (!settings.MICROSOFT_APP_ID || !settings.MICROSOFT_APP_PASSWORD) {
    throw new Error("MICROSOFT_APP_ID and MICROSOFT_APP_PASSWORD are required");
  }
  const token = await getAccessToken(settings.MICROSOFT_APP_ID, settings.MICROSOFT_APP_PASSWORD);

  const path = incoming.id
    ? `v3/conversations/${incoming.conversation.id}/activities/${incoming.id}`
    : `v3/conversations/${incoming.conversation.id}/activities`;

  const resp = await fetch(`${incoming.serviceUrl.replace(/\/$/, "")}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: "message",
      text: reply.text,
      attachments: reply.attachments,
    }),
  });
  if (!resp.ok) throw new Error(`Bot Framework reply failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
}
