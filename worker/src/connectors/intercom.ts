/** Intercom support-conversation connector. Webhook-driven: subscribe your
 * Intercom app to the "conversation.admin.closed" topic (Developer Hub →
 * your app → Webhooks) pointed at `.../webhooks/intercom`, using
 * INTERCOM_CLIENT_SECRET to verify deliveries and INTERCOM_ACCESS_TOKEN
 * (a Custom Actions / access token with `read_conversations` scope) to
 * fetch the full transcript.
 *
 * NOTE: response field names (contacts[].email, conversation_parts shape)
 * are implemented from Intercom's documented Conversation model, not
 * tested against a live workspace — verify against
 * https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/conversation
 * if parsing comes up empty. */

import type { Env } from "../env.js";
import { ingestDocument } from "../rag/ingest.js";
import { resolveAccountId } from "./resolve-account.js";
import { getSetting } from "../settings.js";

interface IntercomConversation {
  id: string;
  created_at: number;
  source: { subject?: string; body?: string; author?: { email?: string } };
  contacts?: { contacts?: { email?: string }[] };
  conversation_parts?: { conversation_parts?: { body?: string; author?: { email?: string; type?: string } }[] };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function toHex(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyIntercomSignature(clientSecret: string, signatureHeader: string | null, rawBody: string): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha1=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(clientSecret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = `sha1=${await toHex(mac)}`;
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

export async function ingestIntercomConversation(env: Env, conversationId: string): Promise<{ skipped: string } | { chunksStored: number }> {
  const accessToken = await getSetting(env, "INTERCOM_ACCESS_TOKEN");
  if (!accessToken) throw new Error("INTERCOM_ACCESS_TOKEN is not set");

  const existing = await env.DB.prepare(`SELECT 1 FROM context_chunks WHERE source = 'intercom' AND source_ref = ?1 LIMIT 1`)
    .bind(conversationId)
    .first();
  if (existing) return { skipped: "already ingested" };

  const resp = await fetch(`https://api.intercom.io/conversations/${conversationId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Intercom-Version": "2.11",
      Accept: "application/json",
    },
  });
  if (!resp.ok) throw new Error(`Intercom API failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  const conversation = await resp.json<IntercomConversation>();

  const emails = [
    conversation.source.author?.email,
    ...(conversation.contacts?.contacts ?? []).map((c) => c.email),
  ].filter((e): e is string => !!e);

  const title = conversation.source.subject || stripHtml(conversation.source.body ?? "").slice(0, 80);
  const accountId = await resolveAccountId(env, { emails, title });
  if (!accountId) return { skipped: `could not resolve an account for conversation ${conversationId}` };

  const bodyLines = [
    conversation.source.body ? stripHtml(conversation.source.body) : "",
    ...(conversation.conversation_parts?.conversation_parts ?? [])
      .filter((p) => p.body)
      .map((p) => `${p.author?.type === "admin" ? "Support" : "Customer"}: ${stripHtml(p.body!)}`),
  ].filter(Boolean);

  return ingestDocument(env, {
    accountId,
    source: "intercom",
    sourceRef: conversationId,
    text: `${title}\n\n${bodyLines.join("\n")}`,
    occurredAt: new Date(conversation.created_at * 1000).toISOString().slice(0, 10),
  });
}
