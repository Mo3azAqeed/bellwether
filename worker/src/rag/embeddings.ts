import type { Env } from "../env.js";

/** bge-base-en-v1.5 — 768 dimensions. The Vectorize index (CONTEXT_INDEX)
 * must be created with matching dimensions; see README "Deploy" steps
 * (`wrangler vectorize create ... --dimensions=768 --metric=cosine`). */
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const result = await env.AI.run(EMBEDDING_MODEL, { text: texts });
  if (!("data" in result) || !result.data) {
    throw new Error("Workers AI returned an async job instead of embeddings — this model shouldn't queue synchronous calls.");
  }
  return result.data;
}

export async function embedOne(env: Env, text: string): Promise<number[]> {
  const [vector] = await embed(env, [text]);
  return vector;
}
