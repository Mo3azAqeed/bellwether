/** Attio CRM connector — pulls notes written on company records into the
 * retriever. Nightly backfill, same shape as HubSpot and Salesforce.
 *
 * Needs an Attio access token: Workspace settings → Developers → create an
 * access token with read access to Records and Notes.
 *
 * Only notes whose parent is a *company* are ingested. Attio lets you attach
 * notes to people and deals too, but those don't map cleanly onto a
 * Bellwether account without guessing, and guessing wrong files a customer's
 * context under someone else's name.
 *
 * NOTE: implemented from Attio's documented v2 REST API — not tested against
 * a live workspace. If parsing comes up empty, check the note and record
 * response shapes against https://docs.attio.com/rest-api. */

import type { Env } from "../env.js";
import { ingestDocument } from "../rag/ingest.js";
import { resolveAccountId } from "./resolve-account.js";
import { getSetting } from "../settings.js";

const API_BASE = "https://api.attio.com/v2";

interface AttioNote {
  id: { note_id: string };
  parent_object: string;
  parent_record_id: string;
  title?: string | null;
  content_plaintext?: string | null;
  created_at?: string | null;
}

/** Attio attribute values are always arrays of historised values — the
 * current one is first. Typed loosely on purpose: workspaces can rename or
 * reshape attributes, and a missing field should skip a note, not throw. */
interface AttioRecord {
  id?: { record_id?: string };
  values?: Record<string, { value?: unknown; domain?: string; full_domain?: string }[] | undefined>;
}

async function attioFetch<T>(token: string, path: string): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (!resp.ok) throw new Error(`Attio API failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  return resp.json<T>();
}

/** Exported for testing. Attio's company `domains` attribute has carried
 * both `domain` and `full_domain` keys depending on workspace age, and
 * `name` is a plain string value — so read defensively and return undefined
 * rather than inventing a value. */
export function readCompanyIdentity(record: AttioRecord): { name?: string; domain?: string } {
  const nameEntry = record.values?.name?.[0];
  const rawName = nameEntry?.value;
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : undefined;

  const domainEntry = record.values?.domains?.[0];
  const rawDomain = domainEntry?.domain ?? domainEntry?.full_domain ?? (typeof domainEntry?.value === "string" ? domainEntry.value : undefined);
  const domain = typeof rawDomain === "string" && rawDomain.includes(".") ? rawDomain.toLowerCase().replace(/^www\./, "") : undefined;

  return { name, domain };
}

const PAGE_SIZE = 50;
/** Caps how far back a single run will page. Notes are deduped by id on
 * ingest, so re-reading the same page costs nothing but a request — the
 * risk worth guarding is the opposite one, a workspace busy enough that a
 * single page doesn't reach back to the last run. Five pages covers 250
 * notes per sync; a workspace writing more than that between syncs should
 * shorten its sync interval. */
const MAX_PAGES = 5;

async function listRecentNotes(token: string): Promise<AttioNote[]> {
  const all: AttioNote[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await attioFetch<{ data: AttioNote[] }>(token, `/notes?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
    const batch = resp.data ?? [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break; // last page
  }
  return all;
}

export async function backfillRecentAttio(env: Env): Promise<void> {
  const token = await getSetting(env, "ATTIO_API_KEY");
  if (!token) return; // connector not configured

  const notes = await listRecentNotes(token);

  // Several notes usually share a company; look each up once per run.
  const companyCache = new Map<string, { name?: string; domain?: string } | undefined>();

  for (const note of notes) {
    const noteId = note.id?.note_id;
    if (!noteId) continue;

    try {
      if (note.parent_object !== "companies") continue;

      const existing = await env.DB.prepare(`SELECT 1 FROM context_chunks WHERE source = 'attio' AND source_ref = ?1 LIMIT 1`)
        .bind(noteId)
        .first();
      if (existing) continue;

      const text = [note.title, note.content_plaintext].filter(Boolean).join("\n").trim();
      if (!text) continue;

      if (!companyCache.has(note.parent_record_id)) {
        const record = await attioFetch<{ data: AttioRecord }>(token, `/objects/companies/records/${note.parent_record_id}`);
        companyCache.set(note.parent_record_id, record.data ? readCompanyIdentity(record.data) : undefined);
      }
      const company = companyCache.get(note.parent_record_id);
      if (!company) continue;

      const accountId = await resolveAccountId(env, {
        emails: company.domain ? [`crm@${company.domain}`] : [],
        title: company.name ?? text.slice(0, 80),
      });
      if (!accountId) continue;

      await ingestDocument(env, {
        accountId,
        source: "attio",
        sourceRef: noteId,
        text,
        occurredAt: note.created_at ? note.created_at.slice(0, 10) : undefined,
      });
    } catch (err) {
      console.error(`attio backfill failed for note ${noteId}`, err);
    }
  }
}
