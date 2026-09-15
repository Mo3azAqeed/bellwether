import { describe, expect, it } from "vitest";
import { excerptOf, recentLines, type RecentDocument } from "./recent.js";

const doc = (over: Partial<RecentDocument> = {}): RecentDocument => ({
  source: "intercom",
  sourceRef: "9981",
  url: "https://app.intercom.com/a/apps/abc/conversations/9981",
  occurredAt: "2026-09-13",
  excerpt: "Third time this month the bulk export has failed.",
  ...over,
});

describe("excerptOf", () => {
  it("leaves a short note exactly as it is", () => {
    expect(excerptOf("SSO cert expired.")).toBe("SSO cert expired.");
  });

  it("flattens the whitespace a transcript arrives with", () => {
    expect(excerptOf("line one\n\n  line two\ttabbed")).toBe("line one line two tabbed");
  });

  it("cuts on a word boundary and marks the cut", () => {
    const out = excerptOf("alpha bravo charlie delta echo foxtrot", 20);
    expect(out).toBe("alpha bravo charlie…");
    expect(out.length).toBeLessThanOrEqual(21);
  });

  it("cuts mid-word rather than throwing most of the excerpt away", () => {
    // One very long word shouldn't collapse the excerpt to nothing just
    // because there's no space late enough to break on.
    expect(excerptOf("supercalifragilisticexpialidocious", 10)).toBe("supercalif…");
  });
});

describe("recentLines", () => {
  it("names the source and date, then the excerpt", () => {
    expect(recentLines([doc()])).toEqual([
      "intercom · 2026-09-13: Third time this month the bulk export has failed.",
    ]);
  });

  it("renders the link however the surface asks for it", () => {
    expect(recentLines([doc()], (label, url) => `<${url}|${label}>`)[0]).toBe(
      "<https://app.intercom.com/a/apps/abc/conversations/9981|intercom · 2026-09-13>: Third time this month the bulk export has failed."
    );
    expect(recentLines([doc()], (label, url) => `[${label}](${url})`)[0]).toContain(
      "[intercom · 2026-09-13](https://app.intercom.com/a/apps/abc/conversations/9981)"
    );
  });

  it("stays plain text when there's nowhere to link to", () => {
    const line = recentLines([doc({ url: null })], (label, url) => `<${url}|${label}>`)[0];
    expect(line).toBe("intercom · 2026-09-13: Third time this month the bulk export has failed.");
    expect(line).not.toContain("<");
  });

  it("drops the date rather than writing an empty separator", () => {
    expect(recentLines([doc({ occurredAt: null, url: null })])[0]).toBe(
      "intercom: Third time this month the bulk export has failed."
    );
  });

  it("returns nothing for an account with nothing on file", () => {
    expect(recentLines([])).toEqual([]);
  });
});
