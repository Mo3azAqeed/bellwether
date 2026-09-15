import { describe, expect, it } from "vitest";
import { buildCitations, citationLines, extractQuotes, unverifiedQuotes } from "./citation.js";
import type { RetrievedChunk } from "./retrieve.js";

const chunk = (over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  id: "c1",
  source: "intercom",
  sourceRef: "9981",
  url: "https://app.intercom.com/a/apps/abc/conversations/9981",
  occurredAt: "2026-08-22",
  chunkText: "SSO cert expired, blocking new logins for the whole team.",
  score: 0.8,
  ...over,
});

describe("buildCitations", () => {
  it("numbers from 1, matching the [n] the model was given", () => {
    // The prompt labels notes [1]…[n] in this order. If these numbers drift,
    // "[2]" in an answer points at the wrong record — worse than no citation.
    const cites = buildCitations([chunk({ id: "a" }), chunk({ id: "b" }), chunk({ id: "c" })]);
    expect(cites.map((c) => c.n)).toEqual([1, 2, 3]);
  });

  it("keeps the record's own words", () => {
    expect(buildCitations([chunk()])[0].text).toBe("SSO cert expired, blocking new logins for the whole team.");
  });

  it("flattens whitespace so a transcript doesn't break the layout", () => {
    expect(buildCitations([chunk({ chunkText: "line one\n\n  line two" })])[0].text).toBe("line one line two");
  });

  it("marks a long note as truncated rather than pretending that's all of it", () => {
    const c = buildCitations([chunk({ chunkText: "x".repeat(400) })], 100)[0];
    expect(c.text).toHaveLength(100);
    expect(c.truncated).toBe(true);
  });
});

describe("citationLines", () => {
  it("puts the number, the source, the link and the words together", () => {
    const [line] = citationLines(buildCitations([chunk()]), (label, url) => `<${url}|${label}>`);
    expect(line).toContain("[1]");
    expect(line).toContain("<https://app.intercom.com/a/apps/abc/conversations/9981|intercom · 2026-08-22>");
    expect(line).toContain("SSO cert expired");
  });

  it("stays plain when the record isn't linkable", () => {
    const [line] = citationLines(buildCitations([chunk({ url: null })]), (label, url) => `<${url}|${label}>`);
    expect(line).toContain("[1] intercom · 2026-08-22");
    expect(line).not.toContain("<");
  });
});

describe("extractQuotes", () => {
  it("finds straight and curly quotes alike", () => {
    expect(extractQuotes('He said "the export keeps failing" yesterday.')).toEqual(["the export keeps failing"]);
    expect(extractQuotes("She wrote “we lost our admin” last month.")).toEqual(["we lost our admin"]);
  });

  it("ignores short quoted fragments that aren't claims", () => {
    expect(extractQuotes('The plan is "pro".')).toEqual([]);
  });
});

describe("unverifiedQuotes", () => {
  const notes = [chunk({ chunkText: "our admin Sarah actually left the company last month, so nobody owns it" })];

  it("passes a quote that really appears in the notes", () => {
    expect(unverifiedQuotes('Their admin left — "our admin Sarah actually left the company" [1].', notes)).toEqual([]);
  });

  it("forgives reflowed whitespace and dropped punctuation", () => {
    // A model reformatting a line break is not fabrication.
    expect(unverifiedQuotes('"our admin Sarah  actually left\nthe company last month" [1]', notes)).toEqual([]);
  });

  it("catches a fluent paraphrase dressed up as a quote", () => {
    // The failure this exists for: a sentence the customer never wrote,
    // read aloud on a renewal call as though they had.
    const out = unverifiedQuotes('They told us "we are extremely unhappy with the product" [1].', notes);
    expect(out).toEqual(["we are extremely unhappy with the product"]);
  });

  it("finds nothing to check in an answer with no quotes", () => {
    expect(unverifiedQuotes("Their admin left in August [1].", notes)).toEqual([]);
  });

  it("treats an answer with no notes behind it as unverifiable", () => {
    expect(unverifiedQuotes('"anything at all here" [1]', [])).toEqual(["anything at all here"]);
  });
});
