import type { Env } from "./env.js";

export interface DbAccount {
  account_id: string;
  name: string;
  plan: string;
  seats_purchased: number;
  renewal_date: string; // ISO date
  csm_owner_name: string | null;
  csm_owner_slack_id: string | null;
  usage_pattern: string | null;
}

const ACCOUNT_COLUMNS = `
  account_id, name, plan, seats_purchased, renewal_date,
  csm_owner_name, csm_owner_slack_id, usage_pattern
`;

export async function getAccountById(db: Env["DB"], accountId: string): Promise<DbAccount | undefined> {
  const row = await db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE account_id = ?1`)
    .bind(accountId)
    .first<DbAccount>();
  return row ?? undefined;
}

/** Fuzzy match: exact name wins, otherwise either side containing the other
 * (case-insensitive) — same behavior as the original Postgres ILIKE query. */
export async function findAccountByName(db: Env["DB"], query: string): Promise<DbAccount | undefined> {
  const q = query.toLowerCase();
  const { results } = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts`).all<DbAccount>();

  let best: DbAccount | undefined;
  for (const row of results) {
    const name = row.name.toLowerCase();
    if (name === q) return row;
    if (!best && (name.includes(q) || q.includes(name))) best = row;
  }
  return best;
}

export async function allDbAccounts(db: Env["DB"]): Promise<DbAccount[]> {
  const { results } = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY name`).all<DbAccount>();
  return results;
}

export async function setOwnerSlackId(db: Env["DB"], accountId: string, slackUserId: string): Promise<void> {
  await db
    .prepare(`UPDATE accounts SET csm_owner_slack_id = ?2, updated_at = datetime('now') WHERE account_id = ?1`)
    .bind(accountId, slackUserId)
    .run();
}

/** Teams' "assign owner" has no equivalent of Slack's real user reference
 * (no Graph API lookup here to turn a typed name into a stable id), so it
 * just overwrites the display name instead — same field the seed data's
 * placeholder owner name lives in. */
export async function setOwnerName(db: Env["DB"], accountId: string, name: string): Promise<void> {
  await db
    .prepare(`UPDATE accounts SET csm_owner_name = ?2, csm_owner_slack_id = NULL, updated_at = datetime('now') WHERE account_id = ?1`)
    .bind(accountId, name)
    .run();
}

export async function recordHealthSnapshot(
  db: Env["DB"],
  accountId: string,
  avgActiveSeats: number,
  baselineDeltaPct: number,
  tier: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO health_snapshots (account_id, avg_active_seats, baseline_delta_pct, tier)
       VALUES (?1, ?2, ?3, ?4)`
    )
    .bind(accountId, avgActiveSeats, baselineDeltaPct, tier)
    .run();
}

export interface HealthSnapshotRow {
  tier: string;
  baseline_delta_pct: number;
  checked_at: string;
}

export async function getLatestSnapshot(db: Env["DB"], accountId: string): Promise<HealthSnapshotRow | undefined> {
  const row = await db
    .prepare(
      `SELECT tier, baseline_delta_pct, checked_at FROM health_snapshots
       WHERE account_id = ?1 ORDER BY checked_at DESC LIMIT 1`
    )
    .bind(accountId)
    .first<HealthSnapshotRow>();
  return row ?? undefined;
}
