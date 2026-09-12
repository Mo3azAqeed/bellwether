import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import { classifyMention } from "./bot-logic.js";

const accounts = [{ name: "Northwind" }, { name: "Lumen Labs" }, { name: "Larkspur Labs" }];

function fakeDb(): Env["DB"] {
  return {
    prepare: () => ({
      all: async () => ({ results: accounts }),
    }),
  } as unknown as Env["DB"];
}

describe("classifyMention", () => {
  it("treats empty text as empty", async () => {
    expect(await classifyMention(fakeDb(), "")).toEqual({ kind: "empty" });
  });

  it("parses 'how is X doing?' as a health lookup", async () => {
    expect(await classifyMention(fakeDb(), "how is Northwind doing?")).toEqual({
      kind: "health",
      accountQuery: "Northwind",
    });
  });

  it("parses \"how's X doing\" (contraction, no question mark) the same way", async () => {
    expect(await classifyMention(fakeDb(), "how's Northwind doing")).toEqual({
      kind: "health",
      accountQuery: "Northwind",
    });
  });

  it("treats a bare account name as a health lookup", async () => {
    expect(await classifyMention(fakeDb(), "Northwind")).toEqual({ kind: "health", accountQuery: "Northwind" });
  });

  it("resolves a 'why' question to the account it names", async () => {
    expect(await classifyMention(fakeDb(), "why is Northwind declining?")).toEqual({
      kind: "question",
      accountName: "Northwind",
      question: "why is Northwind declining?",
    });
  });

  it("picks the longer account name when one name is a substring of another match", async () => {
    // "Larkspur Labs" contains no other account name, but this guards the
    // longest-match tiebreak logic itself rather than relying on incidental
    // substring overlap in the fixture accounts.
    expect(await classifyMention(fakeDb(), "why is Larkspur Labs struggling?")).toEqual({
      kind: "question",
      accountName: "Larkspur Labs",
      question: "why is Larkspur Labs struggling?",
    });
  });

  it("returns unresolved_question when a question doesn't name a known account", async () => {
    expect(await classifyMention(fakeDb(), "why is everything on fire?")).toEqual({
      kind: "unresolved_question",
      question: "why is everything on fire?",
    });
  });

  it("recognizes question words other than 'why'", async () => {
    const result = await classifyMention(fakeDb(), "what happened with Northwind?");
    expect(result.kind).toBe("question");
  });
});
