/** Where ticket drafts live between "Bell noticed something" and "a human
 * agreed".
 *
 * Nothing here talks to Linear or Jira. That separation is the safety
 * property: every path that can propose a ticket — a coding agent, a Slack
 * button, a scheduled sweep — can only reach this table. Filing is a
 * separate, explicit step that takes a draft id, and it files the stored
 * text verbatim, so what a person approved is exactly what lands. */

import type { Env } from "../env.js";
import type { TicketEvidence } from "./draft.js";

export type DraftStatus = "pending" | "filed" | "discarded";

export interface StoredDraft {
  id: string;
  accountId: string;
  accountName?: string;
  title: string;
  body: string;
  evidence: TicketEvidence[];
  status: DraftStatus;
  origin: string;
  tracker: string | null;
  trackerKey: string | null;
  trackerUrl: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface DraftRow {
  id: string;
  account_id: string;
  account_name?: string | null;
  title: string;
  body: string;
  evidence: string;
  status: string;
  origin: string;
  tracker: string | null;
  tracker_key: string | null;
  tracker_url: string | null;
  created_at: string;
  decided_at: string | null;
}

function rowToDraft(row: DraftRow): StoredDraft {
  let evidence: TicketEvidence[] = [];
  try {
    const parsed: unknown = JSON.parse(row.evidence);
    if (Array.isArray(parsed)) evidence = parsed as TicketEvidence[];
  } catch {
    // Unreadable evidence shouldn't hide the draft — the title and body are
    // what a reviewer actually decides on.
  }
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name ?? undefined,
    title: row.title,
    body: row.body,
    evidence,
    status: (row.status as DraftStatus) ?? "pending",
    origin: row.origin,
    tracker: row.tracker,
    trackerKey: row.tracker_key,
    trackerUrl: row.tracker_url,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

const WITH_ACCOUNT = `SELECT d.*, a.name AS account_name FROM ticket_drafts d LEFT JOIN accounts a ON a.account_id = d.account_id`;

export async function saveDraft(
  env: Env,
  input: { accountId: string; title: string; body: string; evidence: TicketEvidence[]; origin: string }
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO ticket_drafts (id, account_id, title, body, evidence, origin) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(id, input.accountId, input.title, input.body, JSON.stringify(input.evidence), input.origin)
    .run();
  return id;
}

export async function getDraft(env: Env, id: string): Promise<StoredDraft | undefined> {
  const row = await env.DB.prepare(`${WITH_ACCOUNT} WHERE d.id = ?1`).bind(id).first<DraftRow>();
  return row ? rowToDraft(row) : undefined;
}

export async function listDrafts(
  env: Env,
  options: { status?: DraftStatus; accountId?: string; limit?: number } = {}
): Promise<StoredDraft[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (options.status) {
    binds.push(options.status);
    clauses.push(`d.status = ?${binds.length}`);
  }
  if (options.accountId) {
    binds.push(options.accountId);
    clauses.push(`d.account_id = ?${binds.length}`);
  }
  binds.push(limit);

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(`${WITH_ACCOUNT}${where} ORDER BY d.created_at DESC LIMIT ?${binds.length}`)
    .bind(...binds)
    .all<DraftRow>();
  return results.map(rowToDraft);
}

/** Marks a draft filed. Conditional on it still being pending, so two
 * approvals racing — a Slack button and an agent, say — can't file the same
 * draft into the backlog twice. Returns false if it had already been
 * decided. */
export async function markFiled(
  env: Env,
  id: string,
  filed: { tracker: string; key: string; url: string }
): Promise<boolean> {
  await env.DB.prepare(
    `UPDATE ticket_drafts
        SET status = 'filed', tracker = ?2, tracker_key = ?3, tracker_url = ?4, decided_at = datetime('now')
      WHERE id = ?1 AND status = 'pending'`
  )
    .bind(id, filed.tracker, filed.key, filed.url)
    .run();

  // Read back rather than trusting meta.changes. The `AND status = 'pending'`
  // clause is what actually prevents a double-file; this only reports which
  // writer won, and reading the stored key answers that on any runtime —
  // ours is there, or the other approval's is.
  const row = await env.DB.prepare(`SELECT tracker_key FROM ticket_drafts WHERE id = ?1`)
    .bind(id)
    .first<{ tracker_key: string | null }>();
  return row?.tracker_key === filed.key;
}

export async function discardDraft(env: Env, id: string): Promise<boolean> {
  await env.DB.prepare(
    `UPDATE ticket_drafts SET status = 'discarded', decided_at = datetime('now') WHERE id = ?1 AND status = 'pending'`
  )
    .bind(id)
    .run();

  const row = await env.DB.prepare(`SELECT status FROM ticket_drafts WHERE id = ?1`)
    .bind(id)
    .first<{ status: string }>();
  return row?.status === "discarded";
}
