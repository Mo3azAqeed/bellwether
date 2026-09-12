/** Pulls the context layer down into a folder of markdown files:
 *
 *   context/
 *     README.md
 *     accounts/
 *       northwind/
 *         account.md          facts, health history, what's on file
 *         notes/              one file per ingested document
 *           2026-08-14-zoom-rec-8891.md
 *
 * Run it with `npm run context:pull` (your deployed database) or
 * `npm run context:pull:local` (the local wrangler dev one).
 *
 * Reads D1 directly through `wrangler d1 execute --json`, the same mechanism
 * scripts/setup-cli.ts writes with — so it needs nothing but a `wrangler
 * login`, no deployed Worker, no MCP token, no SETUP_ADMIN_TOKEN.
 *
 * Nothing is ever deleted. Files that used to be generated but no longer
 * match a row are reported at the end for you to remove yourself, because
 * silently deleting something a person might have edited is worse than
 * leaving a stale file behind.
 *
 * The formatting lives in src/context/format.ts (pure, unit-tested); this
 * file is the I/O around it. */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  groupChunks,
  documentFilename,
  renderAccountMarkdown,
  renderDocumentMarkdown,
  renderIndexMarkdown,
  slugify,
  type AccountRow,
  type SnapshotRow,
  type ChunkRow,
} from "../src/context/format.js";

const local = process.argv.includes("--local");

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const outDir = path.resolve(argValue("--out") ?? path.join("..", "context"));

/** `wrangler d1 execute --json` prints a JSON array of statement results;
 * each has a `results` array of rows. stderr is inherited so wrangler's own
 * errors stay visible, stdin ignored (nothing here is interactive). */
function queryD1<T>(sql: string): T[] {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "bellwether", local ? "--local" : "--remote", "--json", "--command", sql],
    { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );

  // Wrangler can print banners/warnings before the JSON; take from the first
  // bracket rather than assuming the whole of stdout parses.
  const start = raw.indexOf("[");
  if (start === -1) throw new Error(`Could not find JSON in wrangler output:\n${raw.slice(0, 400)}`);
  const parsed = JSON.parse(raw.slice(start)) as { results?: T[] }[];
  return parsed.flatMap((r) => r.results ?? []);
}

function writeFile(filePath: string, contents: string, written: Set<string>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
  written.add(path.resolve(filePath));
}

function existingMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...existingMarkdownFiles(full));
    else if (entry.endsWith(".md")) out.push(path.resolve(full));
  }
  return out;
}

function main(): void {
  const generatedAt = new Date().toISOString();
  const now = new Date();

  console.log(`Reading the ${local ? "local" : "deployed"} database...`);

  const accounts = queryD1<AccountRow>(
    `SELECT account_id, name, plan, seats_purchased, renewal_date, csm_owner_name FROM accounts ORDER BY name`
  );
  if (!accounts.length) {
    console.log("No accounts found — load some first (see \"Load your accounts\" in the README).");
    return;
  }

  const snapshots = queryD1<SnapshotRow>(
    `SELECT account_id, checked_at, avg_active_seats, baseline_delta_pct, tier
     FROM health_snapshots ORDER BY account_id, checked_at DESC`
  );
  const domainRows = queryD1<{ domain: string; account_id: string }>(`SELECT domain, account_id FROM account_domains`);
  // rowid, not id: chunk ids are random UUIDs, so insertion order is the
  // only thing that puts a split document back together in the right order.
  const chunks = queryD1<ChunkRow>(
    `SELECT id, account_id, source, source_ref, chunk_text, occurred_at
     FROM context_chunks ORDER BY account_id, source, source_ref, rowid`
  );

  const snapshotsByAccount = new Map<string, SnapshotRow[]>();
  for (const s of snapshots) {
    const list = snapshotsByAccount.get(s.account_id) ?? [];
    if (list.length < 10) list.push(s); // already newest-first from the query
    snapshotsByAccount.set(s.account_id, list);
  }

  const domainsByAccount = new Map<string, string[]>();
  for (const d of domainRows) {
    domainsByAccount.set(d.account_id, [...(domainsByAccount.get(d.account_id) ?? []), d.domain]);
  }

  const chunksByAccount = new Map<string, ChunkRow[]>();
  for (const c of chunks) {
    chunksByAccount.set(c.account_id, [...(chunksByAccount.get(c.account_id) ?? []), c]);
  }

  const written = new Set<string>();
  const indexEntries: { account: AccountRow; slug: string; tier?: string; documentCount: number }[] = [];
  const usedSlugs = new Set<string>();

  for (const account of accounts) {
    let slug = slugify(account.name, account.account_id);
    // Two customers can share a name; keep folders distinct rather than
    // letting one silently overwrite the other.
    if (usedSlugs.has(slug)) slug = `${slug}-${account.account_id}`;
    usedSlugs.add(slug);

    const accountDir = path.join(outDir, "accounts", slug);
    const accountSnapshots = snapshotsByAccount.get(account.account_id) ?? [];
    const documents = groupChunks(chunksByAccount.get(account.account_id) ?? []);
    const domains = domainsByAccount.get(account.account_id) ?? [];

    writeFile(
      path.join(accountDir, "account.md"),
      renderAccountMarkdown(account, accountSnapshots, domains, documents, now, generatedAt),
      written
    );

    for (const doc of documents) {
      writeFile(
        path.join(accountDir, "notes", documentFilename(doc)),
        renderDocumentMarkdown(doc, account, generatedAt),
        written
      );
    }

    indexEntries.push({ account, slug, tier: accountSnapshots[0]?.tier, documentCount: documents.length });
  }

  writeFile(path.join(outDir, "README.md"), renderIndexMarkdown(indexEntries, generatedAt), written);

  const totalDocs = indexEntries.reduce((sum, e) => sum + e.documentCount, 0);
  console.log(`Wrote ${accounts.length} account(s) and ${totalDocs} document(s) to ${outDir}`);

  const stale = existingMarkdownFiles(path.join(outDir, "accounts")).filter((f) => !written.has(f));
  if (stale.length) {
    console.log(`\n${stale.length} file(s) here weren't regenerated this run — no longer in the database, or renamed:`);
    for (const f of stale.slice(0, 20)) console.log(`  ${path.relative(outDir, f)}`);
    if (stale.length > 20) console.log(`  ...and ${stale.length - 20} more`);
    console.log("Nothing was deleted. Remove them yourself if they're no longer wanted.");
  }

  console.log("\nThis folder contains real customer data. It's gitignored by default — keep it that way.");
}

main();
