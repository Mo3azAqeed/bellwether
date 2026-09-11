/** Zendesk support-ticket connector. Webhook-driven via a Zendesk Trigger
 * (Admin Center → Objects and rules → Triggers), not a native Zendesk
 * webhook signature scheme — Zendesk lets you define the JSON body a
 * trigger sends, so this expects a trigger condition like "Ticket: Status
 * changed to Solved" with the action "Notify webhook" pointed at
 * `.../webhooks/zendesk?secret=<ZENDESK_WEBHOOK_SECRET>` (query param, same
 * pattern as the Fireflies connector) and this JSON body:
 *   { "ticketId": "{{ticket.id}}" }
 *
 * NOTE: the ticket/comments API response shape below is implemented from
 * Zendesk's documented REST API, not tested against a live instance —
 * verify against https://developer.zendesk.com/api-reference/ticketing/tickets/ticket-comments/
 * if parsing comes up empty. */

import type { Env } from "../env.js";
import { ingestDocument } from "../rag/ingest.js";
import { resolveAccountId } from "./resolve-account.js";
import { getSettings } from "../settings.js";

interface ZendeskTicketResponse {
  ticket: { id: number; subject: string; created_at: string; requester_id: number };
  users?: { id: number; email?: string }[];
}

interface ZendeskCommentsResponse {
  comments: { body: string; author_id: number; public: boolean }[];
}

interface ZendeskCreds {
  subdomain: string;
  email: string;
  apiToken: string;
}

async function zendeskGet<T>(creds: ZendeskCreds, path: string): Promise<T> {
  const resp = await fetch(`https://${creds.subdomain}.zendesk.com/api/v2/${path}`, {
    headers: {
      Authorization: `Basic ${btoa(`${creds.email}/token:${creds.apiToken}`)}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) throw new Error(`Zendesk API failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

export async function ingestZendeskTicket(env: Env, ticketId: string | number): Promise<{ skipped: string } | { chunksStored: number }> {
  const settings = await getSettings(env, ["ZENDESK_SUBDOMAIN", "ZENDESK_EMAIL", "ZENDESK_API_TOKEN"]);
  if (!settings.ZENDESK_SUBDOMAIN || !settings.ZENDESK_EMAIL || !settings.ZENDESK_API_TOKEN) {
    throw new Error("ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, and ZENDESK_API_TOKEN are required");
  }
  const creds: ZendeskCreds = { subdomain: settings.ZENDESK_SUBDOMAIN, email: settings.ZENDESK_EMAIL, apiToken: settings.ZENDESK_API_TOKEN };

  const existing = await env.DB.prepare(`SELECT 1 FROM context_chunks WHERE source = 'zendesk' AND source_ref = ?1 LIMIT 1`)
    .bind(String(ticketId))
    .first();
  if (existing) return { skipped: "already ingested" };

  const [ticketData, commentsData] = await Promise.all([
    zendeskGet<ZendeskTicketResponse>(creds, `tickets/${ticketId}.json?include=users`),
    zendeskGet<ZendeskCommentsResponse>(creds, `tickets/${ticketId}/comments.json`),
  ]);

  const requester = ticketData.users?.find((u) => u.id === ticketData.ticket.requester_id);
  const emails = requester?.email ? [requester.email] : [];

  const accountId = await resolveAccountId(env, { emails, title: ticketData.ticket.subject });
  if (!accountId) return { skipped: `could not resolve an account for ticket #${ticketId}` };

  const bodyLines = commentsData.comments.filter((c) => c.public).map((c) => c.body);

  return ingestDocument(env, {
    accountId,
    source: "zendesk",
    sourceRef: String(ticketId),
    text: `${ticketData.ticket.subject}\n\n${bodyLines.join("\n\n")}`,
    occurredAt: ticketData.ticket.created_at.slice(0, 10),
  });
}
