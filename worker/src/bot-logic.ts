/** Platform-agnostic "what does this mention mean, and what's the answer"
 * logic — shared by Slack (src/slack/handlers.ts) and Microsoft Teams
 * (src/teams/handlers.ts) so the two don't drift into answering the same
 * question differently. Everything platform-specific (stripping mention
 * markup, rendering a card, sending the reply) stays in each platform's own
 * handlers.ts; this module only classifies text and resolves data. */

import type { Env } from "./env.js";
import { findAccountByName, allDbAccounts, recordHealthSnapshot, type DbAccount } from "./db.js";
import { computeHealth, type HealthSnapshot } from "./baseline.js";
import { retrieveContext, type RetrievedChunk } from "./rag/retrieve.js";
import { recentContext, type RecentDocument } from "./rag/recent.js";
import { generateAnswer } from "./rag/generate.js";

export type MentionResolution =
  | { kind: "empty" }
  | { kind: "account_not_found"; query: string; sampleNames: string[] }
  | { kind: "health"; account: DbAccount; health: HealthSnapshot; recent: RecentDocument[] }
  | { kind: "health_error"; account: DbAccount }
  | { kind: "question"; account: DbAccount; question: string; answer: string; chunks: RetrievedChunk[] }
  | { kind: "question_error"; account: DbAccount }
  | { kind: "unresolved_question"; question: string };

type ParsedQuery =
  | { kind: "health"; accountQuery: string }
  | { kind: "question"; accountName: string; question: string }
  | { kind: "unresolved_question"; question: string }
  | { kind: "empty" };

/** Classifies mention text — already stripped of platform-specific mention
 * markup by the caller — into a health lookup ("how is X doing?") or an
 * open question ("why is X declining?"). Exported mainly for testing;
 * most callers want resolveMention below. */
export async function classifyMention(db: Env["DB"], text: string): Promise<ParsedQuery> {
  if (!text) return { kind: "empty" };

  const howMatch = text.match(/how(?:'s| is)\s+(.+?)\s+doing\??$/i);
  if (howMatch) return { kind: "health", accountQuery: howMatch[1] };

  const looksLikeQuestion = /\?\s*$/.test(text) || /^(why|what|when|who|which|tell me|how come)\b/i.test(text);
  if (looksLikeQuestion) {
    const accounts = await allDbAccounts(db);
    const lower = text.toLowerCase();
    // Longest matching name wins, so "Northwind Labs" beats a coincidental
    // shorter match if both happened to appear.
    let best: DbAccount | undefined;
    for (const a of accounts) {
      if (lower.includes(a.name.toLowerCase())) {
        if (!best || a.name.length > best.name.length) best = a;
      }
    }
    return best
      ? { kind: "question", accountName: best.name, question: text }
      : { kind: "unresolved_question", question: text };
  }

  return { kind: "health", accountQuery: text.replace(/[?.!]+$/, "").trim() };
}

export async function resolveHealth(env: Env, accountQuery: string): Promise<MentionResolution> {
  if (!accountQuery) return { kind: "empty" };

  const account = await findAccountByName(env.DB, accountQuery);
  if (!account) {
    const sampleNames = (await allDbAccounts(env.DB)).slice(0, 5).map((a) => a.name);
    return { kind: "account_not_found", query: accountQuery, sampleNames };
  }

  let health: HealthSnapshot;
  try {
    health = await computeHealth(env, account);
  } catch (err) {
    console.error("computeHealth failed", err);
    return { kind: "health_error", account };
  }

  await recordHealthSnapshot(env.DB, account.account_id, health.avgActiveSeats, health.baselineDeltaPct, health.tier);

  // The numbers are the answer; what was said lately is the context that
  // stops the numbers being misread. Never worth failing the whole reply
  // over — a health card without it is still a health card.
  let recent: RecentDocument[] = [];
  try {
    recent = await recentContext(env, account.account_id);
  } catch (err) {
    console.error("recentContext failed", err);
  }

  return { kind: "health", account, health, recent };
}

export async function resolveQuestion(env: Env, account: DbAccount, question: string): Promise<MentionResolution> {
  try {
    const chunks = await retrieveContext(env, account.account_id, question);
    const answer = await generateAnswer(env, account.name, question, chunks);
    return { kind: "question", account, question, answer, chunks };
  } catch (err) {
    console.error("retrieveContext/generateAnswer failed", err);
    return { kind: "question_error", account };
  }
}

export async function resolveMention(env: Env, text: string): Promise<MentionResolution> {
  const parsed = await classifyMention(env.DB, text);

  switch (parsed.kind) {
    case "empty":
      return { kind: "empty" };
    case "health":
      return resolveHealth(env, parsed.accountQuery);
    case "question": {
      const account = await findAccountByName(env.DB, parsed.accountName);
      if (!account) return { kind: "empty" }; // shouldn't happen — resolved from the account list moments ago
      return resolveQuestion(env, account, parsed.question);
    }
    case "unresolved_question":
      return { kind: "unresolved_question", question: parsed.question };
  }
}
