/** The derivation behind an answer: what was retrieved, how strongly it
 * scored, the literal prompt that was sent, and which model sent it back.
 *
 * Citations tell you which records an answer used. They don't tell you why
 * *those* records — and when a grounded answer is wrong, the cause is almost
 * never the model's prose. It's retrieval handing the model the wrong five
 * chunks, which no amount of staring at the answer will reveal. A trace is
 * how you find that out in thirty seconds instead of by guesswork.
 *
 * Recording never fails an answer. If the trace can't be written the user
 * still gets their reply — bookkeeping that can take down the feature it
 * documents is worse than no bookkeeping. */

import type { Env } from "../env.js";
import type { RetrievedChunk } from "./retrieve.js";

/** Prompts embed every retrieved excerpt, so they can get long. Capped
 * because a trace is for reading, and because D1 rows shouldn't grow
 * without bound on a free tier. */
const MAX_STORED_PROMPT = 16_000;

/** Traces hold a second copy of customer text. Keeping them forever is a
 * liability nobody asked for, so they expire; override with
 * ANSWER_TRACE_RETENTION_DAYS. */
export const DEFAULT_RETENTION_DAYS = 30;

export interface TracedChunk {
  id: string;
  source: string;
  sourceRef: string | null;
  url: string | null;
  occurredAt: string | null;
  score: number;
  /** Enough to recognise the chunk without storing it twice over. */
  preview: string;
}

export interface AnswerTrace {
  id: string;
  accountId: string;
  accountName?: string;
  question: string;
  answer: string;
  provider: string;
  model: string;
  prompt: string;
  chunks: TracedChunk[];
  retrievalMs: number | null;
  generationMs: number | null;
  createdAt: string;
}

export function toTracedChunks(chunks: RetrievedChunk[]): TracedChunk[] {
  return chunks.map((c) => ({
    id: c.id,
    source: c.source,
    sourceRef: c.sourceRef,
    url: c.url,
    occurredAt: c.occurredAt,
    score: Number(c.score.toFixed(4)),
    preview: c.chunkText.replace(/\s+/g, " ").trim().slice(0, 200),
  }));
}

export interface RecordTraceInput {
  accountId: string;
  question: string;
  answer: string;
  provider: string;
  model: string;
  prompt: string;
  chunks: RetrievedChunk[];
  retrievalMs?: number;
  generationMs?: number;
}

/** Returns the trace id, or undefined when the trace couldn't be stored. */
export async function recordAnswerTrace(env: Env, input: RecordTraceInput): Promise<string | undefined> {
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO answer_traces
         (id, account_id, question, answer, provider, model, prompt, chunks, retrieval_ms, generation_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    )
      .bind(
        id,
        input.accountId,
        input.question,
        input.answer,
        input.provider,
        input.model,
        input.prompt.slice(0, MAX_STORED_PROMPT),
        JSON.stringify(toTracedChunks(input.chunks)),
        input.retrievalMs ?? null,
        input.generationMs ?? null
      )
      .run();
    return id;
  } catch (err) {
    console.error("recordAnswerTrace failed", err);
    return undefined;
  }
}

interface TraceRow {
  id: string;
  account_id: string;
  account_name: string | null;
  question: string;
  answer: string;
  provider: string;
  model: string;
  prompt: string;
  chunks: string;
  retrieval_ms: number | null;
  generation_ms: number | null;
  created_at: string;
}

function rowToTrace(row: TraceRow): AnswerTrace {
  let chunks: TracedChunk[] = [];
  try {
    const parsed: unknown = JSON.parse(row.chunks);
    if (Array.isArray(parsed)) chunks = parsed as TracedChunk[];
  } catch {
    // A trace with unreadable evidence is still worth showing for its
    // prompt and model — better a partial answer to "how did it get this"
    // than an error.
  }
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name ?? undefined,
    question: row.question,
    answer: row.answer,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    chunks,
    retrievalMs: row.retrieval_ms,
    generationMs: row.generation_ms,
    createdAt: row.created_at,
  };
}

export async function getAnswerTrace(env: Env, id: string): Promise<AnswerTrace | undefined> {
  const row = await env.DB.prepare(
    `SELECT t.*, a.name AS account_name
       FROM answer_traces t
       LEFT JOIN accounts a ON a.account_id = t.account_id
      WHERE t.id = ?1`
  )
    .bind(id)
    .first<TraceRow>();
  return row ? rowToTrace(row) : undefined;
}

/** The most recent trace for an account — what "how did you get that?" means
 * when someone asks it right after reading an answer. */
export async function latestAnswerTrace(env: Env, accountId: string): Promise<AnswerTrace | undefined> {
  const row = await env.DB.prepare(
    `SELECT t.*, a.name AS account_name
       FROM answer_traces t
       LEFT JOIN accounts a ON a.account_id = t.account_id
      WHERE t.account_id = ?1
      ORDER BY t.created_at DESC
      LIMIT 1`
  )
    .bind(accountId)
    .first<TraceRow>();
  return row ? rowToTrace(row) : undefined;
}

export async function pruneAnswerTraces(env: Env, retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<number> {
  const days = Math.max(1, Math.floor(retentionDays));
  const { meta } = await env.DB.prepare(
    `DELETE FROM answer_traces WHERE created_at < datetime('now', ?1)`
  )
    .bind(`-${days} days`)
    .run();
  return meta?.changes ?? 0;
}

function ms(value: number | null): string {
  return value === null ? "not recorded" : `${value}ms`;
}

/** Renders a trace as something a person reads, not a JSON dump. Pure, so
 * the wording is testable. `includePrompt` is off by default: it's the most
 * useful field when debugging and the longest when you aren't. */
export function renderTrace(trace: AnswerTrace, options: { includePrompt?: boolean } = {}): string {
  const lines: string[] = [
    `How this answer was built — trace ${trace.id}`,
    "",
    `Asked: ${trace.question}`,
    `About: ${trace.accountName ?? trace.accountId}`,
    `When:  ${trace.createdAt} UTC`,
    "",
    `Answered by ${trace.provider} (${trace.model}).`,
    `Retrieval took ${ms(trace.retrievalMs)}; generation took ${ms(trace.generationMs)}.`,
    "",
  ];

  if (!trace.chunks.length) {
    lines.push(
      "Retrieval returned nothing, so the model was asked to answer with no notes at all — which is why the answer says there's nothing on file rather than guessing.",
      ""
    );
  } else {
    lines.push(
      `Retrieval picked ${trace.chunks.length} excerpt(s), most relevant first. The relevance score is cosine similarity against the question; anything below roughly 0.5 is a weak match and worth distrusting.`,
      ""
    );
    trace.chunks.forEach((c, i) => {
      lines.push(
        `[${i + 1}] ${c.source}${c.occurredAt ? ` · ${c.occurredAt}` : ""} — relevance ${c.score.toFixed(2)}`,
        ...(c.url ? [`    ${c.url}`] : []),
        `    ${c.preview}${c.preview.length >= 200 ? "…" : ""}`,
        ""
      );
    });
  }

  lines.push("Answer:", trace.answer, "");

  if (options.includePrompt) {
    lines.push("The exact prompt sent to the model:", "---", trace.prompt, "---", "");
  } else {
    lines.push("The exact prompt is stored too — ask for it if the retrieved excerpts look right but the answer doesn't.", "");
  }

  return lines.join("\n");
}
