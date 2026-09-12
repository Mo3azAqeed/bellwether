#!/usr/bin/env -S npx tsx
/** Terminal alternative to the /setup web wizard — same integration
 * registry, same live "test before saving" behavior, but never touches a
 * browser or the deployed Worker's HTTP API. Writes straight to D1 via
 * `wrangler d1 execute`, the same way scripts/generate-seed-sql.mjs does,
 * so it needs nothing this repo doesn't already depend on.
 *
 * Usage:
 *   npm run setup          # writes to your remote (deployed) D1 database
 *   npm run setup:local    # writes to your local `wrangler dev` D1 instead
 */

import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INTEGRATIONS, type Integration } from "../src/setup/integrations.js";
import { VALID_FREQUENCIES_HOURS } from "../src/sync-schedule.js";

const local = process.argv.includes("--local");

/** node:readline/promises' own `rl.question()`, called repeatedly across
 * separate awaits, reliably stalls on the second call when stdin is a pipe
 * rather than a real TTY (confirmed with a minimal repro — nothing specific
 * to this script). Driving prompts off the readline interface's async
 * iterator instead doesn't have that problem, so this wraps that in the
 * same "print a prompt, get back the next line" shape the rest of the
 * script wants. */
function createPrompter(rl: ReturnType<typeof createInterface>) {
  const iterator = rl[Symbol.asyncIterator]();
  return async function ask(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    const { value, done } = await iterator.next();
    return done ? "" : value.trim();
  };
}
type Ask = ReturnType<typeof createPrompter>;

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Same "write SQL to a temp file, hand it to wrangler d1 execute --file="
 * pattern the seed script uses — avoids shell-quoting a value the user just
 * typed (which could contain anything, including characters that would
 * break a `--command` string passed straight through a shell). */
function runD1(sql: string): void {
  const file = path.join(tmpdir(), `bellwether-setup-${Date.now()}.sql`);
  writeFileSync(file, sql);
  try {
    // stdin is deliberately NOT inherited: this script's own readline
    // interface reads from the same stdin, and letting wrangler share it
    // would race the two for whatever's still buffered on the pipe.
    // stdout/stderr still show through so wrangler's own success/error
    // output stays visible.
    execFileSync("npx", ["wrangler", "d1", "execute", "bellwether", local ? "--local" : "--remote", `--file=${file}`], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } finally {
    unlinkSync(file);
  }
}

function upsertSetting(key: string, value: string): void {
  runD1(
    `INSERT INTO settings (key, value, updated_at) VALUES (${sqlLiteral(key)}, ${sqlLiteral(value)}, datetime('now')) ` +
      `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`
  );
}

function deleteSetting(key: string): void {
  runD1(`DELETE FROM settings WHERE key = ${sqlLiteral(key)};`);
}

async function configureIntegration(ask: Ask, integration: Integration): Promise<void> {
  console.log(`\n${integration.icon}  ${integration.name}`);
  console.log(integration.instructions);
  console.log("(leave everything blank to skip this one)\n");

  const values: Record<string, string> = {};
  for (const field of integration.fields) {
    values[field.key] = await ask(`  ${field.label}: `);
  }

  if (Object.values(values).every((v) => !v)) {
    const confirm = (await ask("  No values entered — mark as skipped so it stops showing as unconfigured? (y/N): ")).toLowerCase();
    if (confirm === "y") {
      upsertSetting(`SKIPPED_${integration.id}`, "true");
      console.log("  Marked skipped.");
    }
    return;
  }

  if (integration.test) {
    console.log("  Testing...");
    const result = await integration.test(values);
    console.log(`  ${result.ok ? "✓" : "✗"} ${result.message}`);
    if (!result.ok) {
      console.log("  Not saved — fix the value above and try again.");
      return;
    }
  }

  for (const field of integration.fields) {
    if (values[field.key]) upsertSetting(field.key, values[field.key]);
  }
  deleteSetting(`SKIPPED_${integration.id}`);
  console.log("  Saved. Takes effect immediately — no redeploy needed.");
}

async function configureFrequency(ask: Ask): Promise<void> {
  console.log(`\nSync frequency, in hours: ${VALID_FREQUENCIES_HOURS.join(", ")}`);
  const raw = await ask("Pick one: ");
  const hours = Number(raw);
  if (!(VALID_FREQUENCIES_HOURS as readonly number[]).includes(hours)) {
    console.log(`Not one of ${VALID_FREQUENCIES_HOURS.join(", ")} — nothing changed.`);
    return;
  }
  upsertSetting("SYNC_FREQUENCY_HOURS", String(hours));
  console.log("Saved.");
}

async function configureAlertsChannel(ask: Ask): Promise<void> {
  console.log("\nSlack channel ID alerts post to when an account's health tier changes (blank to disable):");
  const channel = await ask("Channel ID (e.g. C0123456789): ");
  if (channel) upsertSetting("SLACK_ALERTS_CHANNEL", channel);
  else deleteSetting("SLACK_ALERTS_CHANNEL");
  console.log("Saved.");
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = createPrompter(rl);
  console.log(`Bellwether CLI setup — writing to your ${local ? "local (wrangler dev)" : "remote (deployed)"} database.`);
  if (!local) console.log("Pass --local instead to target a local `wrangler dev` database.");

  while (true) {
    console.log("\nIntegrations:");
    INTEGRATIONS.forEach((it, i) => console.log(`  ${i + 1}. ${it.icon}  ${it.name} — ${it.description}`));
    console.log(`  ${INTEGRATIONS.length + 1}. Sync frequency`);
    console.log(`  ${INTEGRATIONS.length + 2}. Alerts channel`);
    console.log("  0. Done");

    const raw = await ask("\nPick a number: ");
    const n = Number(raw);

    if (n === 0 || raw === "") break;
    if (n === INTEGRATIONS.length + 1) {
      await configureFrequency(ask);
      continue;
    }
    if (n === INTEGRATIONS.length + 2) {
      await configureAlertsChannel(ask);
      continue;
    }
    const integration = INTEGRATIONS[n - 1];
    if (!integration) {
      console.log("Not a valid number.");
      continue;
    }
    await configureIntegration(ask, integration);
  }

  rl.close();
  console.log("\nDone. Slack itself is set up separately (it needs an app manifest, not just a key) — see the README.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
