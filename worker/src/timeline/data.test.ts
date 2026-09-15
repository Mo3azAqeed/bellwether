import { describe, expect, it } from "vitest";
import { sortEvents, tierChanges, parseTraceChunks, type TimelineEvent } from "./data.js";

describe("tierChanges", () => {
  const row = (checked_at: string, tier: string) => ({
    checked_at,
    tier,
    avg_active_seats: 20,
    baseline_delta_pct: -10,
  });

  it("keeps only the readings where the tier actually moved", () => {
    // Snapshots are written on every sweep and every question, so most of
    // them repeat the one before. Showing all of them would bury everything
    // a human wrote.
    const events = tierChanges([
      row("2026-08-20", "stable"),
      row("2026-08-27", "stable"),
      row("2026-09-05", "watch"),
      row("2026-09-09", "watch"),
      row("2026-09-14", "at_risk"),
    ]);
    expect(events.map((e) => [e.at, e.from, e.to])).toEqual([
      ["2026-08-20", null, "stable"],
      ["2026-09-05", "stable", "watch"],
      ["2026-09-14", "watch", "at_risk"],
    ]);
  });

  it("reads rows oldest-first even when handed them newest-first", () => {
    const events = tierChanges([row("2026-09-14", "at_risk"), row("2026-08-20", "stable")]);
    expect(events.map((e) => e.to)).toEqual(["stable", "at_risk"]);
    expect(events[1].from).toBe("stable");
  });

  it("records a recovery as readily as a decline", () => {
    const events = tierChanges([row("2026-09-01", "at_risk"), row("2026-09-20", "stable")]);
    expect(events.at(-1)).toMatchObject({ from: "at_risk", to: "stable" });
  });

  it("returns nothing for an account with no snapshots", () => {
    expect(tierChanges([])).toEqual([]);
  });
});

describe("sortEvents", () => {
  const ctx = (at: string): TimelineEvent => ({
    kind: "context",
    at,
    source: "zoom",
    sourceRef: null,
    url: null,
    excerpt: "",
    chunkCount: 1,
  });
  const answer = (at: string): TimelineEvent => ({
    kind: "answer",
    at,
    traceId: "t",
    question: "q",
    answer: "a",
    provider: "anthropic",
    model: "m",
    used: [],
  });

  it("puts the newest first regardless of which stream it came from", () => {
    const sorted = sortEvents([ctx("2026-08-14"), answer("2026-09-15 10:00:00"), ctx("2026-09-01")]);
    expect(sorted.map((e) => e.at)).toEqual(["2026-09-15 10:00:00", "2026-09-01", "2026-08-14"]);
  });

  it("sorts a date-only entry above a same-day timestamp", () => {
    // A ticket dated 2026-09-13 and a sweep that ran at 09:00 that day are
    // the same day; the human-authored thing reads better first.
    const sorted = sortEvents([answer("2026-09-13 09:00:00"), ctx("2026-09-13")]);
    expect(sorted[0].kind).toBe("context");
  });

  it("doesn't mutate what it was given", () => {
    const input = [ctx("2026-08-01"), ctx("2026-09-01")];
    sortEvents(input);
    expect(input[0].at).toBe("2026-08-01");
  });
});

describe("parseTraceChunks", () => {
  it("reads the sources an answer was built from", () => {
    const used = parseTraceChunks(
      '[{"source":"zoom","occurredAt":"2026-08-14","url":"https://zoom.us/x","score":0.8,"preview":"…"}]'
    );
    expect(used).toEqual([{ source: "zoom", occurredAt: "2026-08-14", url: "https://zoom.us/x" }]);
  });

  it("survives a trace whose evidence is unreadable rather than failing the page", () => {
    expect(parseTraceChunks("{not json")).toEqual([]);
    expect(parseTraceChunks('"a string"')).toEqual([]);
    expect(parseTraceChunks("[]")).toEqual([]);
  });

  it("skips entries with no source instead of rendering a blank row", () => {
    expect(parseTraceChunks('[{"occurredAt":"2026-01-01"},{"source":"zendesk"}]')).toEqual([
      { source: "zendesk", occurredAt: null, url: null },
    ]);
  });
});
