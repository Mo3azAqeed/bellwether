/** Fireflies.ai meeting-transcript connector — the first of what should be
 * several (Otter, Fathom, Zoom's own transcript webhook, Intercom, Zendesk
 * all fit the same shape). Picked Fireflies first because its API is built
 * for exactly this — pulling meeting content into other tools — unlike
 * Otter/Fathom which lean more consumer/closed, and unlike Gong which is
 * enterprise-priced overkill for the teams this project targets.
 *
 * Two paths feed transcripts in:
 *   1. Webhook (near-real-time): Fireflies POSTs a small "done processing"
 *      ping to /webhooks/fireflies; we then pull the full transcript.
 *   2. Nightly backfill (src/index.ts `scheduled`): catches anything a
 *      missed/failed webhook delivery would otherwise lose.
 *
 * NOTE: Fireflies' GraphQL schema isn't pinned by a types package here —
 * verify field names against https://docs.fireflies.ai/graphql-api if
 * responses stop matching what this expects to parse.
 */

import type { Env } from "../env.js";
import { ingestDocument } from "../rag/ingest.js";
import { resolveAccountId } from "./resolve-account.js";
import { getSetting } from "../settings.js";

const GRAPHQL_ENDPOINT = "https://api.fireflies.ai/graphql";

interface FirefliesSentence {
  text: string;
  speaker_name: string;
}

interface FirefliesTranscript {
  id: string;
  title: string;
  date: string | number;
  participants: string[];
  sentences: FirefliesSentence[];
}

async function graphql<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const resp = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new Error(`Fireflies API failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  }
  const json = await resp.json<{ data?: T; errors?: { message: string }[] }>();
  if (json.errors?.length) {
    throw new Error(`Fireflies API returned errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error("Fireflies API returned no data");
  return json.data;
}

async function fetchTranscript(apiKey: string, transcriptId: string): Promise<FirefliesTranscript> {
  const data = await graphql<{ transcript: FirefliesTranscript }>(
    apiKey,
    `query Transcript($id: String!) {
      transcript(id: $id) {
        id
        title
        date
        participants
        sentences { text speaker_name }
      }
    }`,
    { id: transcriptId }
  );
  return data.transcript;
}

async function listRecentTranscriptIds(apiKey: string, sinceMs: number): Promise<string[]> {
  const data = await graphql<{ transcripts: { id: string; date: string | number }[] }>(
    apiKey,
    `query Recent($limit: Int!) {
      transcripts(limit: $limit) { id date }
    }`,
    { limit: 50 }
  );
  return data.transcripts.filter((t) => normalizeDate(t.date).getTime() >= sinceMs).map((t) => t.id);
}

function normalizeDate(date: string | number): Date {
  if (typeof date === "number") return new Date(date);
  const asNumber = Number(date);
  return Number.isFinite(asNumber) && String(asNumber) === date ? new Date(asNumber) : new Date(date);
}

export async function ingestFirefliesTranscript(env: Env, transcriptId: string): Promise<{ skipped: string } | { chunksStored: number }> {
  const apiKey = await getSetting(env, "FIREFLIES_API_KEY");
  if (!apiKey) throw new Error("FIREFLIES_API_KEY is not set");

  const existing = await env.DB.prepare(
    `SELECT 1 FROM context_chunks WHERE source = 'fireflies' AND source_ref = ?1 LIMIT 1`
  )
    .bind(transcriptId)
    .first();
  if (existing) return { skipped: "already ingested" };

  const transcript = await fetchTranscript(apiKey, transcriptId);
  const accountId = await resolveAccountId(env, { emails: transcript.participants, title: transcript.title });
  if (!accountId) return { skipped: `could not resolve an account for "${transcript.title}"` };

  const text = transcript.sentences.map((s) => `${s.speaker_name}: ${s.text}`).join("\n");
  const occurredAt = normalizeDate(transcript.date).toISOString().slice(0, 10);

  return ingestDocument(env, {
    accountId,
    source: "fireflies",
    sourceRef: transcript.id,
    text: `${transcript.title}\n\n${text}`,
    occurredAt,
  });
}

/** Called from the nightly cron: catches transcripts whose webhook delivery
 * never arrived. Looks back 2 days (not just 1) so a single missed night
 * doesn't lose anything permanently. */
export async function backfillRecentFireflies(env: Env): Promise<void> {
  const apiKey = await getSetting(env, "FIREFLIES_API_KEY");
  if (!apiKey) return;

  const sinceMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const ids = await listRecentTranscriptIds(apiKey, sinceMs);

  for (const id of ids) {
    try {
      await ingestFirefliesTranscript(env, id);
    } catch (err) {
      console.error(`fireflies backfill failed for transcript ${id}`, err);
    }
  }
}
