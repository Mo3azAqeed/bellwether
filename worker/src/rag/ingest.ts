import type { Env } from "../env.js";
import { chunkText } from "./chunk.js";
import { embed } from "./embeddings.js";

export interface IngestInput {
  accountId: string;
  /** Free-form source label: "intercom", "zendesk", "call_notes", "manual", etc.
   * Deliberately a string, not an enum — new connectors shouldn't need a
   * schema change to plug in. */
  source: string;
  sourceRef?: string;
  /** A link to the record this came from, when the connector's payload
   * carried one. Stored verbatim and preferred over anything derived from
   * the id later — the vendor's own URL is the one that's right. */
  sourceUrl?: string;
  text: string;
  occurredAt?: string; // ISO date
}

/** Chunks, embeds, and stores one document. Safe to call repeatedly for the
 * same sourceRef — each call adds new chunks rather than deduplicating, so
 * a connector that re-syncs the same ticket should pass a stable sourceRef
 * and the caller is responsible for not re-ingesting unchanged content. */
export async function ingestDocument(env: Env, input: IngestInput): Promise<{ chunksStored: number }> {
  const chunks = chunkText(input.text);
  if (chunks.length === 0) return { chunksStored: 0 };

  const vectors = await embed(env, chunks);

  const ids = chunks.map(() => crypto.randomUUID());

  await env.CONTEXT_INDEX.upsert(
    ids.map((id, i) => ({
      id,
      values: vectors[i],
      metadata: {
        accountId: input.accountId,
        source: input.source,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      },
    }))
  );

  const stmt = env.DB.prepare(
    `INSERT INTO context_chunks (id, account_id, source, source_ref, chunk_text, occurred_at, source_url)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  );
  await env.DB.batch(
    ids.map((id, i) =>
      stmt.bind(
        id,
        input.accountId,
        input.source,
        input.sourceRef ?? null,
        chunks[i],
        input.occurredAt ?? null,
        input.sourceUrl ?? null
      )
    )
  );

  return { chunksStored: chunks.length };
}
