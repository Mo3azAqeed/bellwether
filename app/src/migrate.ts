import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = path.resolve(__dirname, "../../data-seed/accounts.json");

interface SeedAccount {
  account_id: string;
  name: string;
  plan: string;
  seats_purchased: number;
  usage_pattern: string;
  csm_owner: string;
  renewal_date: string;
}

async function main() {
  const accounts: SeedAccount[] = JSON.parse(readFileSync(ACCOUNTS_PATH, "utf-8"));

  let inserted = 0;
  for (const a of accounts) {
    await pool.query(
      `INSERT INTO accounts (account_id, name, plan, seats_purchased, renewal_date, csm_owner_name, usage_pattern)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (account_id) DO UPDATE SET
         name = EXCLUDED.name,
         plan = EXCLUDED.plan,
         seats_purchased = EXCLUDED.seats_purchased,
         renewal_date = EXCLUDED.renewal_date,
         csm_owner_name = EXCLUDED.csm_owner_name,
         usage_pattern = EXCLUDED.usage_pattern,
         updated_at = now()`,
      [a.account_id, a.name, a.plan, a.seats_purchased, a.renewal_date, a.csm_owner, a.usage_pattern]
    );
    inserted++;
  }

  const { rows } = await pool.query("SELECT count(*)::int AS n FROM accounts");
  console.log(`Migrated ${inserted} accounts. Table now has ${rows[0].n} rows.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
