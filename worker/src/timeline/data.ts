/** Everything known about an account, on one axis: time.
 *
 * A relevance score answers "why did retrieval pick this?", which matters
 * for about ten seconds while you debug a bad answer. The question a CSM
 * actually has, before a call, is "where did all of this come from, and in
 * what order did it happen?" — the champion leaving in August, the ticket
 * that followed, the tier dropping two weeks later, the answer Bell gave
 * about it on Monday. Laid on one axis, that reads as a story. Laid out as
 * search results, it doesn't.
 *
 * So this assembles three streams into one chronology:
 *
 *   context  — what a source system recorded (calls, tickets, CRM notes)
 *   tier     — when the health tier actually moved, not every sample
 *   answer   — what Bell was asked, what it said, and what it used
 *
 * The queries live here; the rendering lives in page.ts. */

import type { Env } from "../env.js";
import { getSettings } from "../settings.js";
import { configFromSettings, sourceLink, SOURCE_LINK_SETTING_KEYS } from "../rag/source-link.js";
import { excerptOf } from "../rag/recent.js";

export interface ContextEvent {
  kind: "context";
  at: string;
  source: string;
  sourceRef: string | null;
  url: string | null;
  excerpt: string;
  chunkCount: number;
}

export interface TierEvent {
  kind: "tier";
  at: string;
  from: string | null;
  to: string;
  activeSeats: number;
  deltaPct: number;
}

export interface AnswerEvent {
  kind: "answer";
  at: string;
  traceId: string;
  question: string;
  answer: string;
  provider: string;
  model: string;
  used: { source: string; occurredAt: string | null; url: string | null }[];
}

export type TimelineEvent = ContextEvent | TierEvent | AnswerEvent;

export interface TimelineAccount {
  accountId: string;
  name: string;
  plan: string;
  seatsPurchased: number;
  renewalDate: string;
  owner: string | null;
  tier: string | null;
}

export interface Timeline {
  account: TimelineAccount;
  events: TimelineEvent[];
}

const DEFAULT_LIMIT = 60;

/** Normalises the mix of date-only and datetime strings the three tables
 * carry, so one sort handles all of them. A date-only value sorts to the
 * end of its day, which keeps "the ticket came in that day" above "the
 * nightly sweep ran that day" — the human-authored thing first. */
function sortKey(at: string): string {
  return at.length <= 10 ? `${at}T23:59:59` : at.replace(" ", "T");
}

export function sortEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => sortKey(b.at).localeCompare(sortKey(a.at)));
}

/** Health snapshots are recorded on every sweep and on every question, so
 * most of them say the same thing as the one before. Only the changes are
 * events; the rest is sampling noise and would bury the timeline. */
export function tierChanges(
  rows: { checked_at: string; tier: string; avg_active_seats: number; baseline_delta_pct: number }[]
): TierEvent[] {
  // Oldest first so "what did it change from" is the row before it.
  const chronological = [...rows].sort((a, b) => a.checked_at.localeCompare(b.checked_at));
  const events: TierEvent[] = [];
  let previous: string | null = null;

  for (const row of chronological) {
    if (row.tier !== previous) {
      events.push({
        kind: "tier",
        at: row.checked_at,
        from: previous,
        to: row.tier,
        activeSeats: row.avg_active_seats,
        deltaPct: row.baseline_delta_pct,
      });
      previous = row.tier;
    }
  }
  return events;
}

interface TraceChunkJson {
  source?: string;
  occurredAt?: string | null;
  url?: string | null;
}

export function parseTraceChunks(json: string): AnswerEvent["used"] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return (parsed as TraceChunkJson[])
      .filter((c) => typeof c.source === "string")
      .map((c) => ({ source: c.source as string, occurredAt: c.occurredAt ?? null, url: c.url ?? null }));
  } catch {
    return [];
  }
}

export async function buildTimeline(env: Env, accountId: string, limit = DEFAULT_LIMIT): Promise<Timeline | undefined> {
  const account = await env.DB.prepare(
    `SELECT account_id, name, plan, seats_purchased, renewal_date, csm_owner_name FROM accounts WHERE account_id = ?1`
  )
    .bind(accountId)
    .first<{
      account_id: string;
      name: string;
      plan: string;
      seats_purchased: number;
      renewal_date: string;
      csm_owner_name: string | null;
    }>();
  if (!account) return undefined;

  const capped = Math.max(1, Math.min(200, Math.floor(limit)));

  const [contextRows, snapshotRows, traceRows, settings] = await Promise.all([
    env.DB.prepare(
      `SELECT source, source_ref, source_url, occurred_at, chunk_text, COUNT(*) AS chunk_count, MIN(rowid) AS first_row
         FROM context_chunks
        WHERE account_id = ?1
        GROUP BY COALESCE(source_ref, id)
        ORDER BY COALESCE(occurred_at, '') DESC, first_row DESC
        LIMIT ?2`
    )
      .bind(accountId, capped)
      .all<{
        source: string;
        source_ref: string | null;
        source_url: string | null;
        occurred_at: string | null;
        chunk_text: string;
        chunk_count: number;
      }>(),
    env.DB.prepare(
      `SELECT checked_at, tier, avg_active_seats, baseline_delta_pct
         FROM health_snapshots WHERE account_id = ?1 ORDER BY checked_at DESC LIMIT 200`
    )
      .bind(accountId)
      .all<{ checked_at: string; tier: string; avg_active_seats: number; baseline_delta_pct: number }>(),
    env.DB.prepare(
      `SELECT id, question, answer, provider, model, chunks, created_at
         FROM answer_traces WHERE account_id = ?1 ORDER BY created_at DESC LIMIT 40`
    )
      .bind(accountId)
      .all<{
        id: string;
        question: string;
        answer: string;
        provider: string;
        model: string;
        chunks: string;
        created_at: string;
      }>(),
    getSettings(env, [...SOURCE_LINK_SETTING_KEYS]),
  ]);

  const linkConfig = configFromSettings(settings);

  const context: ContextEvent[] = contextRows.results
    // A document with no date can't be placed on a timeline. Showing it at
    // "now" would put an eighteen-month-old note at the top.
    .filter((row) => !!row.occurred_at)
    .map((row) => ({
      kind: "context",
      at: row.occurred_at as string,
      source: row.source,
      sourceRef: row.source_ref,
      url: sourceLink({ source: row.source, sourceRef: row.source_ref, sourceUrl: row.source_url }, linkConfig) ?? null,
      excerpt: excerptOf(row.chunk_text, 320),
      chunkCount: row.chunk_count,
    }));

  const tiers = tierChanges(snapshotRows.results);

  const answers: AnswerEvent[] = traceRows.results.map((row) => ({
    kind: "answer",
    at: row.created_at,
    traceId: row.id,
    question: row.question,
    answer: row.answer,
    provider: row.provider,
    model: row.model,
    used: parseTraceChunks(row.chunks),
  }));

  return {
    account: {
      accountId: account.account_id,
      name: account.name,
      plan: account.plan,
      seatsPurchased: account.seats_purchased,
      renewalDate: account.renewal_date,
      owner: account.csm_owner_name,
      tier: snapshotRows.results[0]?.tier ?? null,
    },
    events: sortEvents([...context, ...tiers, ...answers]),
  };
}
