import { describe, expect, it } from "vitest";
import { renderTrace, toTracedChunks, type AnswerTrace } from "./trace.js";
import type { RetrievedChunk } from "./retrieve.js";

const trace = (over: Partial<AnswerTrace> = {}): AnswerTrace => ({
  id: "6f1c-trace",
  accountId: "acct-001",
  accountName: "Northwind",
  question: "why is Northwind declining?",
  answer: "Their admin champion left in August [1].",
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
  prompt: "You're answering a customer success question…",
  chunks: [
    {
      id: "c1",
      source: "zoom",
      sourceRef: "rec-8891",
      url: "https://zoom.us/rec/share/xyz",
      occurredAt: "2026-08-14",
      score: 0.8123,
      preview: "our admin Sarah actually left the company last month",
    },
  ],
  retrievalMs: 42,
  generationMs: 910,
  createdAt: "2026-09-15 10:04:00",
  ...over,
});

describe("toTracedChunks", () => {
  it("keeps what identifies a chunk and a preview, not the whole text again", () => {
    const retrieved: RetrievedChunk[] = [
      {
        id: "c1",
        source: "intercom",
        sourceRef: "9981",
        url: "https://app.intercom.com/x",
        occurredAt: "2026-09-13",
        chunkText: "a".repeat(500),
        score: 0.812345,
      },
    ];
    const [traced] = toTracedChunks(retrieved);
    expect(traced.preview).toHaveLength(200);
    expect(traced.score).toBe(0.8123);
    expect(traced.sourceRef).toBe("9981");
  });

  it("flattens whitespace so a transcript preview stays one line", () => {
    const [traced] = toTracedChunks([
      { id: "c", source: "zoom", sourceRef: null, url: null, occurredAt: null, chunkText: "line\n\none   two", score: 0.5 },
    ]);
    expect(traced.preview).toBe("line one two");
  });
});

describe("renderTrace", () => {
  it("answers the question the feature exists for: which evidence, how strong, which model", () => {
    const out = renderTrace(trace());
    expect(out).toContain("trace 6f1c-trace");
    expect(out).toContain("why is Northwind declining?");
    expect(out).toContain("Answered by anthropic (claude-haiku-4-5-20251001)");
    expect(out).toContain("Retrieval took 42ms; generation took 910ms");
    expect(out).toContain("relevance 0.81");
    expect(out).toContain("https://zoom.us/rec/share/xyz");
    expect(out).toContain("our admin Sarah actually left");
  });

  it("explains what the relevance number means, since nobody should have to guess", () => {
    expect(renderTrace(trace())).toContain("cosine similarity");
  });

  it("names the account rather than an opaque id when it has one", () => {
    expect(renderTrace(trace())).toContain("About: Northwind");
    expect(renderTrace(trace({ accountName: undefined }))).toContain("About: acct-001");
  });

  it("withholds the prompt by default and includes it on request", () => {
    expect(renderTrace(trace())).not.toContain("You're answering a customer success question");
    expect(renderTrace(trace())).toContain("The exact prompt is stored too");

    const full = renderTrace(trace(), { includePrompt: true });
    expect(full).toContain("You're answering a customer success question");
  });

  it("says outright when retrieval found nothing — the most common cause of a bad answer", () => {
    const out = renderTrace(trace({ chunks: [] }));
    expect(out).toContain("Retrieval returned nothing");
    expect(out).toContain("no notes at all");
  });

  it("doesn't claim a timing it never measured", () => {
    const out = renderTrace(trace({ retrievalMs: null, generationMs: null }));
    expect(out).toContain("not recorded");
    expect(out).not.toContain("nullms");
  });

  it("skips the link line for a chunk with nowhere to link to", () => {
    const out = renderTrace(trace({ chunks: [{ ...trace().chunks[0], url: null }] }));
    expect(out).toContain("relevance 0.81");
    expect(out).not.toContain("https://");
  });
});
