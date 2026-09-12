/** Renders the context layer as a folder of markdown files — one directory
 * per account, one file per ingested document, plus a generated summary.
 *
 * Why files at all, when the same data is already queryable over MCP: a
 * coding agent reads files natively and for free, with no protocol round
 * trip and no tokens spent on tool plumbing. Files are also greppable,
 * diffable, and reviewable in a pull request, so a CS team can see how an
 * account's story changed between two weeks rather than only what it says
 * today.
 *
 * Everything here is pure — no filesystem, no network, no clock — so the
 * output is testable and the I/O stays in scripts/context-pull.ts. */

export interface AccountRow {
  account_id: string;
  name: string;
  plan: string;
  seats_purchased: number;
  renewal_date: string;
  csm_owner_name: string | null;
}

export interface SnapshotRow {
  account_id: string;
  checked_at: string;
  avg_active_seats: number;
  baseline_delta_pct: number;
  tier: string;
}

export interface ChunkRow {
  id: string;
  account_id: string;
  source: string;
  source_ref: string | null;
  chunk_text: string;
  occurred_at: string | null;
}

/** One ingested document, reassembled from the chunks it was split into. */
export interface ContextDocument {
  key: string; // stable per document: the source_ref, or the chunk id when there isn't one
  source: string;
  sourceRef: string | null;
  occurredAt: string | null;
  text: string;
  chunkCount: number;
}

/** Folder-safe, stable, and readable. Falls back to the account id when a
 * name has nothing slug-able in it (non-Latin scripts, emoji-only, etc.) —
 * an unreadable-but-correct folder beats a collision. */
export function slugify(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Chunking is a retrieval detail; a human or an agent reading the folder
 * wants the document back in one piece. Rows must arrive in insertion order
 * (the caller orders by rowid) since chunk ids are random UUIDs and carry no
 * sequence of their own. */
export function groupChunks(rows: ChunkRow[]): ContextDocument[] {
  const byKey = new Map<string, ContextDocument>();

  for (const row of rows) {
    // Documents ingested without a source_ref can't be grouped with
    // anything else, so each chunk stands alone under its own id.
    const key = row.source_ref ?? row.id;
    const existing = byKey.get(key);
    if (existing) {
      existing.text += `\n\n${row.chunk_text}`;
      existing.chunkCount += 1;
      existing.occurredAt ??= row.occurred_at;
    } else {
      byKey.set(key, {
        key,
        source: row.source,
        sourceRef: row.source_ref,
        occurredAt: row.occurred_at,
        text: row.chunk_text,
        chunkCount: 1,
      });
    }
  }

  return [...byKey.values()];
}

/** Date first so the folder sorts chronologically in any file browser. */
export function documentFilename(doc: ContextDocument): string {
  const date = doc.occurredAt?.slice(0, 10) || "undated";
  const ref = slugify(doc.key, doc.key).slice(0, 24) || "doc";
  return `${date}-${slugify(doc.source, "source")}-${ref}.md`;
}

function yamlValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === "number") return String(value);
  // Quote anything that could be read as YAML syntax rather than a string.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function frontmatter(fields: Record<string, string | number | null | undefined>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return ["---", ...lines, "---"].join("\n");
}

export function daysUntil(isoDate: string, now: Date): number | undefined {
  const target = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(target)) return undefined;
  return Math.round((target - now.getTime()) / 86_400_000);
}

function tierLabel(tier: string): string {
  return tier === "at_risk" ? "at risk" : tier;
}

export function renderDocumentMarkdown(
  doc: ContextDocument,
  account: AccountRow,
  generatedAt: string
): string {
  return [
    frontmatter({
      account: account.name,
      account_id: account.account_id,
      source: doc.source,
      source_ref: doc.sourceRef,
      occurred_at: doc.occurredAt,
      generated_at: generatedAt,
    }),
    "",
    doc.text.trim(),
    "",
  ].join("\n");
}

export function renderAccountMarkdown(
  account: AccountRow,
  snapshots: SnapshotRow[],
  domains: string[],
  documents: ContextDocument[],
  now: Date,
  generatedAt: string
): string {
  const latest = snapshots[0];
  const days = daysUntil(account.renewal_date, now);
  const renewal =
    days === undefined
      ? account.renewal_date
      : days >= 0
        ? `${account.renewal_date} (in ${days} days)`
        : `${account.renewal_date} (${Math.abs(days)} days ago)`;

  const lines: string[] = [
    frontmatter({
      account_id: account.account_id,
      name: account.name,
      plan: account.plan,
      seats_purchased: account.seats_purchased,
      renewal_date: account.renewal_date,
      owner: account.csm_owner_name,
      domains: domains.join(", "),
      tier: latest?.tier ?? null,
      generated_at: generatedAt,
    }),
    "",
    `# ${account.name}`,
    "",
    `Renews ${renewal} · ${account.plan} plan · ${account.seats_purchased} seats purchased · owner ${account.csm_owner_name ?? "unassigned"}`,
    "",
  ];

  if (domains.length) {
    lines.push(`Domains: ${domains.join(", ")}`, "");
  }

  lines.push("## Health", "");
  if (!latest) {
    lines.push(
      "No health snapshot recorded yet — usage is computed live when asked, and stored here after the first scheduled sync.",
      ""
    );
  } else {
    const delta = latest.baseline_delta_pct >= 0 ? `+${latest.baseline_delta_pct}` : `${latest.baseline_delta_pct}`;
    lines.push(
      `Latest check ${latest.checked_at}: **${tierLabel(latest.tier)}** — ${latest.avg_active_seats} of ${account.seats_purchased} seats active, ${delta}% against its own baseline.`,
      "",
      "| checked | tier | active seats | vs baseline |",
      "|---|---|---|---|",
      ...snapshots.map(
        (s) =>
          `| ${s.checked_at} | ${tierLabel(s.tier)} | ${s.avg_active_seats} | ${s.baseline_delta_pct >= 0 ? "+" : ""}${s.baseline_delta_pct}% |`
      ),
      ""
    );
  }

  lines.push("## Context on file", "");
  if (!documents.length) {
    lines.push(
      "Nothing ingested for this account yet. Connect a source (call transcripts, support tickets, CRM notes) so the \"why\" questions have something to answer from.",
      ""
    );
  } else {
    const bySource = new Map<string, number>();
    for (const doc of documents) bySource.set(doc.source, (bySource.get(doc.source) ?? 0) + 1);
    const summary = [...bySource.entries()].map(([source, count]) => `${count} from ${source}`).join(", ");
    lines.push(`${documents.length} document(s) in \`notes/\` — ${summary}.`, "");

    const dated = [...documents].sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? ""));
    for (const doc of dated.slice(0, 20)) {
      lines.push(`- [${doc.occurredAt ?? "undated"} · ${doc.source}](notes/${documentFilename(doc)})`);
    }
    if (dated.length > 20) lines.push(`- …and ${dated.length - 20} more in \`notes/\``);
    lines.push("");
  }

  return lines.join("\n");
}

export function renderIndexMarkdown(
  accounts: { account: AccountRow; slug: string; tier?: string; documentCount: number }[],
  generatedAt: string
): string {
  const rows = accounts.map(
    (a) =>
      `| [${a.account.name}](accounts/${a.slug}/account.md) | ${a.tier ? tierLabel(a.tier) : "—"} | ${a.account.renewal_date} | ${a.documentCount} |`
  );

  return [
    "# Bellwether context",
    "",
    `Generated ${generatedAt} by \`npm run context:pull\`. **Everything here is generated** — edit the source systems, not these files, or your next pull will overwrite you.`,
    "",
    "This folder contains real customer data. It is gitignored by default; keep it that way unless you have decided, deliberately, that this repo is the right place for it.",
    "",
    "| Account | Tier | Renews | Documents |",
    "|---|---|---|---|",
    ...rows,
    "",
    "## For coding agents",
    "",
    "Each account folder has an `account.md` (facts, health history, an index of what's on file) and a `notes/` folder of the underlying source material — call transcripts, support tickets, CRM notes — one file per document, with frontmatter naming its source and date.",
    "",
    "Read these directly. It is cheaper and more complete than asking over MCP, and you see the source rather than a summary of it. Use the MCP tools when you need something these files can't give you: live usage numbers (`get_account_health`) or semantic search across a large history (`get_account_context`).",
    "",
  ].join("\n");
}
