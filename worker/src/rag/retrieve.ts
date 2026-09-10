import type { Env } from "../env.js";
import { embedOne } from "./embeddings.js";

export interface RetrievedChunk {
  id: string;
  source: string;
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
    `SELECT id, chunk_text, source, occurred_at FROM context_chunks WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<{ id: string; chunk_text: string; source: string; occurred_at: string | null }>();

  const byId = new Map(results.map((r) => [r.id, r]));

  return matches.matches
    .map((m) => {
      const row = byId.get(m.id);
      if (!row) return undefined;
      return {
        id: m.id,
        source: row.source,
        occurredAt: row.occurred_at,
        chunkText: row.chunk_text,
        score: m.score,
      };
    })
    .filter((c): c is RetrievedChunk => c !== undefined);
}
