/** HubSpot CRM connector — pulls notes (calls, meeting logs, anything a CSM
 * writes on a company/deal) into the retriever. Nightly backfill, like
 * Google Meet, rather than a webhook: HubSpot webhooks need a public app +
 * subscription setup per object type, which is more moving parts than a
 * private-app token for a first cut. Revisit if a day's lag turns out to
 * matter.
 *
 * Needs a HubSpot private app (Settings → Integrations → Private Apps) with
 * `crm.objects.notes.read` and `crm.objects.companies.read` scopes.
 *
 * NOTE: implemented from HubSpot's documented CRM v3/v4 API — not tested
 * against a live portal. Verify against
 * https://developers.hubspot.com/docs/api/crm/notes if parsing comes up
 * empty. */

import type { Env } from "../env.js";
import { ingestDocument } from "../rag/ingest.js";
import { resolveAccountId } from "./resolve-account.js";

const API_BASE = "https://api.hubapi.com";

interface HubSpotNote {
  id: string;
  properties: { hs_note_body?: string; hs_timestamp?: string };
}

async function hubspotFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
  });
  if (!resp.ok) throw new Error(`HubSpot API failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

async function searchRecentNotes(token: string, sinceMs: number): Promise<HubSpotNote[]> {
  const data = await hubspotFetch<{ results: HubSpotNote[] }>(token, "/crm/v3/objects/notes/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "hs_timestamp", operator: "GTE", value: String(sinceMs) }] }],
      properties: ["hs_note_body", "hs_timestamp"],
      sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
      limit: 100,
    }),
  });
  return data.results;
}

async function findAssociatedCompanyDomain(token: string, noteId: string): Promise<{ domain?: string; name?: string } | undefined> {
  const assoc = await hubspotFetch<{ results: { toObjectId: string }[] }>(token, `/crm/v4/objects/notes/${noteId}/associations/company`);
  const companyId = assoc.results[0]?.toObjectId;
  if (!companyId) return undefined;

  const company = await hubspotFetch<{ properties: { domain?: string; name?: string } }>(
    token,
    `/crm/v3/objects/companies/${companyId}?properties=domain,name`
  );
  return company.properties;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function backfillRecentHubSpot(env: Env): Promise<void> {
  if (!env.HUBSPOT_ACCESS_TOKEN) return; // connector not configured

  const sinceMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const notes = await searchRecentNotes(env.HUBSPOT_ACCESS_TOKEN, sinceMs);

  for (const note of notes) {
    try {
      const existing = await env.DB.prepare(`SELECT 1 FROM context_chunks WHERE source = 'hubspot' AND source_ref = ?1 LIMIT 1`)
        .bind(note.id)
        .first();
      if (existing) continue;

      const body = note.properties.hs_note_body;
      if (!body) continue;

      const company = await findAssociatedCompanyDomain(env.HUBSPOT_ACCESS_TOKEN, note.id);
      if (!company) continue;

      const text = stripHtml(body);
      const accountId = await resolveAccountId(env, {
        emails: company.domain ? [`crm@${company.domain}`] : [],
        title: company.name ?? text.slice(0, 80),
      });
      if (!accountId) continue;

      await ingestDocument(env, {
        accountId,
        source: "hubspot",
        sourceRef: note.id,
        text,
        occurredAt: note.properties.hs_timestamp ? new Date(Number(note.properties.hs_timestamp)).toISOString().slice(0, 10) : undefined,
      });
    } catch (err) {
      console.error(`hubspot backfill failed for note ${note.id}`, err);
    }
  }
}
