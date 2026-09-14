import { describe, expect, it } from "vitest";
import {
  slugify,
  groupChunks,
  documentFilename,
  daysUntil,
  renderAccountMarkdown,
  renderDocumentMarkdown,
  renderIndexMarkdown,
  type AccountRow,
  type ChunkRow,
  type SnapshotRow,
} from "./format.js";

const account: AccountRow = {
  account_id: "acct-001",
  name: "Northwind",
  plan: "pro",
  seats_purchased: 40,
  renewal_date: "2026-11-05",
  csm_owner_name: "Maya",
};

const NOW = new Date("2026-09-12T00:00:00Z");
const GENERATED = "2026-09-12T19:30:00.000Z";

function chunk(over: Partial<ChunkRow>): ChunkRow {
  return {
    id: "c1",
    account_id: "acct-001",
    source: "zoom",
    source_ref: "rec-8891",
    source_url: null,
    chunk_text: "text",
    occurred_at: "2026-08-14",
    ...over,
  };
}

describe("slugify", () => {
  it("makes a readable folder name", () => {
    expect(slugify("Northwind Labs", "acct-001")).toBe("northwind-labs");
  });

  it("strips accents and punctuation", () => {
    expect(slugify("Café & Co.", "acct-002")).toBe("cafe-co");
  });

  it("falls back to the account id when a name has nothing slug-able", () => {
    expect(slugify("日本語", "ACCT-003")).toBe("acct-003");
    expect(slugify("", "acct-004")).toBe("acct-004");
  });

  it("caps length so a pathological name can't blow up the path", () => {
    expect(slugify("a".repeat(200), "acct-005").length).toBe(60);
  });
});

describe("groupChunks", () => {
  it("reassembles a split document in row order, under its source_ref", () => {
    const docs = groupChunks([
      chunk({ id: "c1", chunk_text: "first half" }),
      chunk({ id: "c2", chunk_text: "second half" }),
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0].text).toBe("first half\n\nsecond half");
    expect(docs[0].chunkCount).toBe(2);
    expect(docs[0].key).toBe("rec-8891");
  });

  it("keeps documents with different source_refs apart", () => {
    const docs = groupChunks([chunk({ id: "c1", source_ref: "a" }), chunk({ id: "c2", source_ref: "b" })]);
    expect(docs).toHaveLength(2);
  });

  it("treats chunks with no source_ref as standalone documents", () => {
    const docs = groupChunks([
      chunk({ id: "c1", source_ref: null }),
      chunk({ id: "c2", source_ref: null }),
    ]);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.key)).toEqual(["c1", "c2"]);
  });

  it("backfills occurred_at from a later chunk when the first one lacks it", () => {
    const docs = groupChunks([
      chunk({ id: "c1", occurred_at: null }),
      chunk({ id: "c2", occurred_at: "2026-08-14" }),
    ]);
    expect(docs[0].occurredAt).toBe("2026-08-14");
  });
});

describe("documentFilename", () => {
  it("leads with the date so notes sort chronologically", () => {
    const [doc] = groupChunks([chunk({})]);
    expect(documentFilename(doc)).toBe("2026-08-14-zoom-rec-8891.md");
  });

  it("marks undated documents rather than inventing a date", () => {
    const [doc] = groupChunks([chunk({ occurred_at: null })]);
    expect(documentFilename(doc)).toBe("undated-zoom-rec-8891.md");
  });
});

describe("daysUntil", () => {
  it("counts forward to a future renewal", () => {
    expect(daysUntil("2026-11-05", NOW)).toBe(54);
  });

  it("goes negative for a past date", () => {
    expect(daysUntil("2026-09-02", NOW)).toBe(-10);
  });

  it("returns undefined for an unparseable date instead of NaN", () => {
    expect(daysUntil("not-a-date", NOW)).toBeUndefined();
  });
});

describe("renderDocumentMarkdown", () => {
  it("writes frontmatter naming the source, then the text verbatim", () => {
    const [doc] = groupChunks([chunk({ chunk_text: "our admin Sarah left last month" })]);
    const md = renderDocumentMarkdown(doc, account, GENERATED);
    expect(md).toContain('source: "zoom"');
    expect(md).toContain('source_ref: "rec-8891"');
    expect(md).toContain('occurred_at: "2026-08-14"');
    expect(md).toContain('account_id: "acct-001"');
    expect(md).toContain("our admin Sarah left last month");
  });

  it("escapes quotes so a title can't break the frontmatter", () => {
    const [doc] = groupChunks([chunk({ source_ref: 'say "hi"' })]);
    expect(renderDocumentMarkdown(doc, account, GENERATED)).toContain('source_ref: "say \\"hi\\""');
  });

  it("records where the original lives when the connector captured a link", () => {
    const [doc] = groupChunks([chunk({ source_url: "https://zoom.us/rec/share/xyz" })]);
    expect(renderDocumentMarkdown(doc, account, GENERATED)).toContain('source_url: "https://zoom.us/rec/share/xyz"');
  });

  it("writes an empty frontmatter value rather than null for a missing date", () => {
    const [doc] = groupChunks([chunk({ occurred_at: null })]);
    expect(renderDocumentMarkdown(doc, account, GENERATED)).toContain('occurred_at: ""');
  });
});

describe("renderAccountMarkdown", () => {
  const snapshots: SnapshotRow[] = [
    { account_id: "acct-001", checked_at: "2026-09-12", avg_active_seats: 12, baseline_delta_pct: -52, tier: "at_risk" },
    { account_id: "acct-001", checked_at: "2026-09-11", avg_active_seats: 18, baseline_delta_pct: -24, tier: "watch" },
  ];

  it("leads with the facts and the latest health, spelled out", () => {
    const docs = groupChunks([chunk({})]);
    const md = renderAccountMarkdown(account, snapshots, ["northwind.io"], docs, NOW, GENERATED);
    expect(md).toContain("# Northwind");
    expect(md).toContain("Renews 2026-11-05 (in 54 days)");
    expect(md).toContain("owner Maya");
    expect(md).toContain("**at risk**");
    expect(md).toContain("12 of 40 seats active, -52% against its own baseline");
    expect(md).toContain("| 2026-09-11 | watch | 18 | -24% |");
    expect(md).toContain("Domains: northwind.io");
  });

  it("links each document into notes/", () => {
    const docs = groupChunks([chunk({})]);
    const md = renderAccountMarkdown(account, snapshots, [], docs, NOW, GENERATED);
    expect(md).toContain("1 document(s) in `notes/` — 1 from zoom.");
    expect(md).toContain("[2026-08-14 · zoom](notes/2026-08-14-zoom-rec-8891.md)");
  });

  it("offers a way through to the original record when one is known", () => {
    const docs = groupChunks([chunk({ source_url: "https://zoom.us/rec/share/xyz" })]);
    const md = renderAccountMarkdown(account, snapshots, [], docs, NOW, GENERATED);
    expect(md).toContain("[open in zoom](https://zoom.us/rec/share/xyz)");
  });

  it("says plainly when there's no health history or context yet", () => {
    const md = renderAccountMarkdown(account, [], [], [], NOW, GENERATED);
    expect(md).toContain("No health snapshot recorded yet");
    expect(md).toContain("Nothing ingested for this account yet");
  });

  it("shows a positive delta with a sign so the direction is never ambiguous", () => {
    const up: SnapshotRow[] = [{ ...snapshots[0], baseline_delta_pct: 8, tier: "stable" }];
    expect(renderAccountMarkdown(account, up, [], [], NOW, GENERATED)).toContain("+8% against its own baseline");
  });
});

describe("renderIndexMarkdown", () => {
  it("tables every account and warns that the folder is generated and private", () => {
    const md = renderIndexMarkdown(
      [{ account, slug: "northwind", tier: "at_risk", documentCount: 3 }],
      GENERATED
    );
    expect(md).toContain("[Northwind](accounts/northwind/account.md)");
    expect(md).toContain("| at risk | 2026-11-05 | 3 |");
    expect(md).toContain("**Everything here is generated**");
    expect(md).toContain("gitignored by default");
    expect(md).toContain("## For coding agents");
  });
});
