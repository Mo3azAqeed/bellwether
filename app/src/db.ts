import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({ connectionString: getDatabaseConfig().url });

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

export async function getAccountById(accountId: string): Promise<DbAccount | undefined> {
  const { rows } = await pool.query<DbAccount>(
    `SELECT account_id, name, plan, seats_purchased, renewal_date::text,
            csm_owner_name, csm_owner_slack_id, usage_pattern
     FROM accounts WHERE account_id = $1`,
    [accountId]
  );
  return rows[0];
}

export async function findAccountByName(query: string): Promise<DbAccount | undefined> {
  const { rows } = await pool.query<DbAccount>(
    `SELECT account_id, name, plan, seats_purchased, renewal_date::text,
            csm_owner_name, csm_owner_slack_id, usage_pattern
     FROM accounts
     WHERE lower(name) = lower($1)
        OR lower(name) LIKE '%' || lower($1) || '%'
        OR lower($1) LIKE '%' || lower(name) || '%'
     ORDER BY (lower(name) = lower($1)) DESC
     LIMIT 1`,
    [query]
  );
  return rows[0];
}

export async function allDbAccounts(): Promise<DbAccount[]> {
  const { rows } = await pool.query<DbAccount>(
    `SELECT account_id, name, plan, seats_purchased, renewal_date::text,
            csm_owner_name, csm_owner_slack_id, usage_pattern
     FROM accounts ORDER BY name`
  );
  return rows;
}

export async function setOwnerSlackId(accountId: string, slackUserId: string): Promise<void> {
  await pool.query(
    `UPDATE accounts SET csm_owner_slack_id = $2, updated_at = now() WHERE account_id = $1`,
    [accountId, slackUserId]
  );
}

export async function recordHealthSnapshot(
  accountId: string,
  avgActiveSeats: number,
  baselineDeltaPct: number,
  tier: string
): Promise<void> {
  await pool.query(
    `INSERT INTO health_snapshots (account_id, avg_active_seats, baseline_delta_pct, tier)
     VALUES ($1, $2, $3, $4)`,
    [accountId, avgActiveSeats, baselineDeltaPct, tier]
  );
}

export async function getLatestSnapshot(accountId: string) {
  const { rows } = await pool.query(
    `SELECT tier, baseline_delta_pct, checked_at FROM health_snapshots
     WHERE account_id = $1 ORDER BY checked_at DESC LIMIT 1`,
    [accountId]
  );
  return rows[0];
}
