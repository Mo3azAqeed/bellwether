#!/usr/bin/env node
// Turns ../data-seed/accounts.json into a SQL file D1 can apply directly:
//   node scripts/generate-seed-sql.mjs > seed.sql
//   wrangler d1 execute bellwether --remote --file=seed.sql
//
// A plain script rather than a Worker route: seeding is a one-time/rare
// operation an operator runs from their machine, not something that needs
// to be reachable over the internet.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const accountsPath = path.resolve(__dirname, "../../data-seed/accounts.json");

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

const COLUMNS = ["account_id", "name", "plan", "seats_purchased", "renewal_date", "csm_owner_name", "usage_pattern"];

const accounts = JSON.parse(readFileSync(accountsPath, "utf-8"));

for (const a of accounts) {
  const values = [a.account_id, a.name, a.plan, a.seats_purchased, a.renewal_date, a.csm_owner, a.usage_pattern];
  const updateClause = COLUMNS.filter((c) => c !== "account_id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");

  console.log(
    `INSERT INTO accounts (${COLUMNS.join(", ")}) VALUES (${values.map(sqlLiteral).join(", ")}) ` +
      `ON CONFLICT(account_id) DO UPDATE SET ${updateClause}, updated_at = datetime('now');`
  );
}
