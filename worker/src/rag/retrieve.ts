import type { Env } from "../env.js";
import { getSettings } from "../settings.js";
import { embedOne } from "./embeddings.js";
import { configFromSettings, sourceLink, SOURCE_LINK_SETTING_KEYS } from "./source-link.js";

export interface RetrievedChunk {
  id: string;
  source: string;
  /** The source system's own id for the document — the thing that makes a
   * citation checkable rather than merely plausible. */
  sourceRef: string | null;
  /** Where to go and read the original, when we can work out where that is.
   * Null when the source has no linkable record. */
  url: string | null;
  occurredAt: string | null;
  chunkText: string;
  score: number;
}

const DEFAULT_TOP_K = 5;

export async function retrieveContext(
  env: Env,
  accountId: string,
  question: string,
  topK: number = DEFAULT_TOP_K
): Promise<RetrievedChunk[]> {
  const queryVector = await embedOne(env, question);

  const matches = await env.CONTEXT_INDEX.query(queryVector, {
    topK,
    filter: { accountId },
    returnMetadata: true,
  });

  if (matches.matches.length === 0) return [];

  const ids = matches.matches.map((m) => m.id);
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, chunk_text, source, source_ref, source_url, occurred_at
     FROM context_chunks WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<{
      id: string;
      chunk_text: string;
      source: string;
      source_ref: string | null;
      source_url: string | null;
      occurred_at: string | null;
    }>();

  const byId = new Map(results.map((r) => [r.id, r]));
  // One settings read per retrieval rather than per chunk: every consumer
  // (Slack, Teams, MCP, the file export) gets links without wiring of its own.
  const linkConfig = configFromSettings(await getSettings(env, [...SOURCE_LINK_SETTING_KEYS]));

  return matches.matches
    .map((m) => {
      const row = byId.get(m.id);
      if (!row) return undefined;
      return {
        id: m.id,
        source: row.source,
        sourceRef: row.source_ref,
        url:
          sourceLink({ source: row.source, sourceRef: row.source_ref, sourceUrl: row.source_url }, linkConfig) ??
          null,
        occurredAt: row.occurred_at,
        chunkText: row.chunk_text,
        score: m.score,
      };
    })
    .filter((c): c is RetrievedChunk => c !== undefined);
}
