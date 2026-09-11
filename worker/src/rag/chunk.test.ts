import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk.js";

describe("chunkText", () => {
  it("returns the whole text as one chunk when it's short", () => {
    const text = "Northwind's admin churned in August. New champion hasn't onboarded yet.";
    expect(chunkText(text)).toEqual([text]);
  });

  it("returns nothing for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   ")).toEqual([]);
  });

  it("splits long text into multiple chunks, each within the max size", () => {
    const sentence = "This is a sentence about the account's usage pattern and support history. ";
    const text = sentence.repeat(40); // well past the 1200-char default
    const chunks = chunkText(text, 300, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300 + 80); // slack for the joined overlap sentence
  });

  it("carries a small overlap between consecutive chunks", () => {
    const sentence = "This is a sentence about the account's usage pattern and support history. ";
    const text = sentence.repeat(40);
    const chunks = chunkText(text, 300, 40);
    const endOfFirst = chunks[0].slice(-20);
    expect(chunks[1]).toContain(endOfFirst.trim().split(" ").slice(-3).join(" "));
  });
});
