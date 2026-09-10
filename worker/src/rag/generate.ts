import type { Env } from "../env.js";
import type { RetrievedChunk } from "./retrieve.js";

/** Free, runs on Workers AI — the default so a fresh deploy costs nothing
 * beyond the Workers Paid plan Vectorize itself requires. Swap for a
 * larger Workers AI model if answer quality matters more than cost. */
const WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** Only used if ANTHROPIC_API_KEY is set — noticeably better answers, small
 * per-call cost. Haiku, not a larger model, because this is a short
 * grounded-QA task, not open-ended reasoning. */
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

/** Only used if OPENROUTER_API_KEY is set (and ANTHROPIC_API_KEY isn't) —
 * one API key, choice of ~model, and includes genuinely free (":free")
 * models if you want $0 generation without being tied to Workers AI's
 * model lineup. Override with OPENROUTER_MODEL; check openrouter.ai/models
 * for current pricing before picking a paid one. */
const DEFAULT_OPENROUTER_MODEL = "meta-llama/llama-3.1-8b-instruct";

function buildPrompt(accountName: string, question: string, chunks: RetrievedChunk[]): string {
  const context = chunks.length
    ? chunks.map((c, i) => `[${i + 1}] (${c.source}${c.occurredAt ? `, ${c.occurredAt}` : ""}) ${c.chunkText}`).join("\n\n")
    : "(no notes on file for this account)";

  return [
    `You're answering a customer success question about the account "${accountName}".`,
    `Answer only from the notes below — if they don't cover it, say so plainly instead of guessing.`,
    `Cite sources inline like [1]. Keep it to 2-4 sentences.`,
    ``,
    `Notes:`,
    context,
    ``,
    `Question: ${question}`,
  ].join("\n");
}

async function generateWithWorkersAI(env: Env, prompt: string): Promise<string> {
  const result = await env.AI.run(WORKERS_AI_MODEL, {
    messages: [{ role: "user", content: prompt }],
  });
  return typeof result.response === "string" ? result.response : JSON.stringify(result);
}

async function generateWithAnthropic(apiKey: string, prompt: string): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Anthropic API failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  }
  const json = await resp.json<{ content: { type: string; text?: string }[] }>();
  return json.content.find((b) => b.type === "text")?.text ?? "";
}

async function generateWithOpenRouter(env: Env, prompt: string): Promise<string> {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      // Optional per OpenRouter's docs (attributes usage to the app in
      // their dashboard) — harmless to omit, cheap to include.
      "HTTP-Referer": "https://github.com/Mo3azAqeed/bellwether",
      "X-Title": "Bellwether",
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`OpenRouter API failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  }
  const json = await resp.json<{ choices: { message: { content: string } }[] }>();
  return json.choices[0]?.message.content ?? "";
}

export async function generateAnswer(
  env: Env,
  accountName: string,
  question: string,
  chunks: RetrievedChunk[]
): Promise<string> {
  const prompt = buildPrompt(accountName, question, chunks);
  if (env.ANTHROPIC_API_KEY) return generateWithAnthropic(env.ANTHROPIC_API_KEY, prompt);
  if (env.OPENROUTER_API_KEY) return generateWithOpenRouter(env, prompt);
  return generateWithWorkersAI(env, prompt);
}
