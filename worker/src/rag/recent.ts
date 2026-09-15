/** The most recent things said about an account, regardless of what was
 * asked.
 *
 * Health is computed from usage alone: seats, baseline, renewal date. That
 * makes it possible — routine, even — for Bell to report an account as
 * healthy on the same morning its last support ticket was someone venting
 * about a broken feature. The numbers aren't wrong. They're just not the
 * whole account, and a CSM who finds that out on the call learns to distrust
 * the card.
 *
 * So every health answer also carries the last few things on file. This is
 * deliberately NOT semantic search: no question has been asked, so there is
 * nothing to be relevant to. It is "here is what happened lately", ordered
 * by when it happened, and it costs one indexed query — no embedding call,
 * no model call, nothing to configure. */

import type { Env } from "../env.js";
import { getSettings } from "../settings.js";
import { configFromSettings, sourceLink, SOURCE_LINK_SETTING_KEYS } from "./source-link.js";

export interface RecentDocument {
  source: string;
  sourceRef: string | null;
  /** Where to read the whole thing, when we know. */
  url: string | null;
  occurredAt: string | null;
  excerpt: string;
}

const DEFAULT_LIMIT = 3;
const EXCERPT_CHARS = 180;

/** Trims to a whole word and marks the cut, so nobody mistakes a truncated
 * excerpt for the end of the sentence. */
export function excerptOf(text: string, max: number = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

interface RecentRow {
  source: string;
  source_ref: string | null;
  source_url: string | null;
  occurred_at: string | null;
  chunk_text: string;
}

export async function recentContext(
  env: Env,
  accountId: string,
  limit: number = DEFAULT_LIMIT
): Promise<RecentDocument[]> {
  // Grouped by document so a long transcript split into six chunks doesn't
  // crowd out the other five things that happened that week. SQLite takes
  // the bare columns from the row that produced MIN(rowid) — the first
  // chunk, which is the start of the document and so reads as an opening
  // rather than a fragment from the middle.
  const { results } = await env.DB.prepare(
    `SELECT source, source_ref, source_url, occurred_at, chunk_text, MIN(rowid) AS first_row
       FROM context_chunks
      WHERE account_id = ?1
      GROUP BY COALESCE(source_ref, id)
      ORDER BY COALESCE(occurred_at, '') DESC, first_row DESC
      LIMIT ?2`
  )
    .bind(accountId, Math.max(1, Math.min(10, Math.floor(limit))))
    .all<RecentRow>();

  if (!results.length) return [];

  const linkConfig = configFromSettings(await getSettings(env, [...SOURCE_LINK_SETTING_KEYS]));

  return results.map((row) => ({
    source: row.source,
    sourceRef: row.source_ref,
    url: sourceLink({ source: row.source, sourceRef: row.source_ref, sourceUrl: row.source_url }, linkConfig) ?? null,
    occurredAt: row.occurred_at,
    excerpt: excerptOf(row.chunk_text),
  }));
}

/** One line per document, in plain prose, for whichever surface is asking.
 * `link` decides how that surface writes a hyperlink — Slack and Teams
 * disagree, and MCP wants the bare URL. */
export function recentLines(
  docs: RecentDocument[],
  link: (label: string, url: string) => string = (label) => label
): string[] {
  return docs.map((d) => {
    const label = `${d.source}${d.occurredAt ? ` · ${d.occurredAt}` : ""}`;
    return `${d.url ? link(label, d.url) : label}: ${d.excerpt}`;
  });
}
