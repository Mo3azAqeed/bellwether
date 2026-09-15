import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";

vi.mock("../db.js", () => ({
  allDbAccounts: vi.fn(),
  findAccountByName: vi.fn(),
}));
vi.mock("../bot-logic.js", () => ({
  resolveHealth: vi.fn(),
  resolveQuestion: vi.fn(),
}));
vi.mock("../rag/retrieve.js", () => ({
  retrieveContext: vi.fn(),
}));
vi.mock("../rag/trace.js", () => ({
  getAnswerTrace: vi.fn(),
  latestAnswerTrace: vi.fn(),
  renderTrace: vi.fn(() => "RENDERED TRACE"),
}));

const { allDbAccounts, findAccountByName } = await import("../db.js");
const { resolveHealth, resolveQuestion } = await import("../bot-logic.js");
const { retrieveContext } = await import("../rag/retrieve.js");
const { getAnswerTrace, latestAnswerTrace, renderTrace } = await import("../rag/trace.js");

const fakeAccount = {
  account_id: "1",
  name: "Northwind",
  plan: "pro",
  seats_purchased: 40,
  renewal_date: "2026-11-01",
  csm_owner_name: null,
  csm_owner_slack_id: null,
  usage_pattern: null,
};
const { handleMcpRequest, callTool, TOOLS } = await import("./server.js");

const fakeEnv = {} as Env;

function rpcRequest(body: unknown): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleMcpRequest", () => {
  it("answers initialize with protocol info and a tools capability", async () => {
    const res = await handleMcpRequest(rpcRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }), fakeEnv);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: { tools: {} }, serverInfo: { name: "bellwether" } },
    });
  });

  it("lists all six tools with schemas", async () => {
    const res = await handleMcpRequest(rpcRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }), fakeEnv);
    const body = await res.json();
    expect(body.result.tools).toEqual(TOOLS);
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "list_accounts",
      "get_account_health",
      "ask_about_account",
      "get_account_context",
      "get_account_timeline",
      "explain_answer",
    ]);
  });

  it("responds 202 with no body to the initialized notification", async () => {
    const res = await handleMcpRequest(rpcRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), fakeEnv);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("returns a JSON-RPC parse error with HTTP 400 on invalid JSON", async () => {
    const req = new Request("https://example.com/mcp", { method: "POST", body: "{not json" });
    const res = await handleMcpRequest(req, fakeEnv);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("returns Invalid Request for a non-JSON-RPC-2.0 body", async () => {
    const res = await handleMcpRequest(rpcRequest({ method: "initialize" }), fakeEnv);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });

  it("returns Method not found for an unknown method", async () => {
    const res = await handleMcpRequest(rpcRequest({ jsonrpc: "2.0", id: 3, method: "prompts/list" }), fakeEnv);
    const body = await res.json();
    expect(body.error.code).toBe(-32601);
  });

  it("routes tools/call through callTool and wraps the result", async () => {
    vi.mocked(allDbAccounts).mockResolvedValueOnce([]);
    const res = await handleMcpRequest(
      rpcRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_accounts", arguments: {} } }),
      fakeEnv
    );
    const body = await res.json();
    expect(body.result.content[0].text).toBe("No accounts found.");
  });

  it("rejects tools/call with no tool name", async () => {
    const res = await handleMcpRequest(rpcRequest({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} }), fakeEnv);
    const body = await res.json();
    expect(body.error.code).toBe(-32602);
  });
});

describe("callTool", () => {
  it("list_accounts with no query returns every account", async () => {
    vi.mocked(allDbAccounts).mockResolvedValueOnce([
      { account_id: "1", name: "Northwind", plan: "pro", seats_purchased: 40, renewal_date: "2026-11-01", csm_owner_name: "Maya", csm_owner_slack_id: null, usage_pattern: null },
    ]);
    const result = await callTool(fakeEnv, "list_accounts", {});
    expect(result.content[0].text).toContain("Northwind — renews 2026-11-01, owner Maya");
    expect(result.isError).toBeFalsy();
  });

  it("list_accounts filters by query substring", async () => {
    vi.mocked(allDbAccounts).mockResolvedValueOnce([
      { account_id: "1", name: "Northwind", plan: "pro", seats_purchased: 40, renewal_date: "2026-11-01", csm_owner_name: null, csm_owner_slack_id: null, usage_pattern: null },
      { account_id: "2", name: "Lumen Labs", plan: "pro", seats_purchased: 20, renewal_date: "2026-12-01", csm_owner_name: null, csm_owner_slack_id: null, usage_pattern: null },
    ]);
    const result = await callTool(fakeEnv, "list_accounts", { query: "north" });
    expect(result.content[0].text).toContain("Northwind");
    expect(result.content[0].text).not.toContain("Lumen");
  });

  it("get_account_health requires an account", async () => {
    const result = await callTool(fakeEnv, "get_account_health", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("account is required");
  });

  it("get_account_health formats a healthy resolution", async () => {
    vi.mocked(resolveHealth).mockResolvedValueOnce({
      kind: "health",
      account: { account_id: "1", name: "Northwind", plan: "pro", seats_purchased: 40, renewal_date: "2026-11-01", csm_owner_name: "Maya", csm_owner_slack_id: null, usage_pattern: null },
      health: { avgActiveSeats: 12, seatsPurchased: 40, baselineDeltaPct: -52, tier: "at_risk", renewalDaysOut: 23 },
      recent: [],
    });
    const result = await callTool(fakeEnv, "get_account_health", { account: "Northwind" });
    expect(result.content[0].text).toContain(
      "Northwind: at risk. 12 of 40 seats active (-52% vs its own baseline), renews in 23 days. Owner: Maya."
    );
    expect(result.isError).toBeFalsy();
  });

  it("says outright that the tier is the only signal when nothing is ingested", async () => {
    vi.mocked(resolveHealth).mockResolvedValueOnce({
      kind: "health",
      account: fakeAccount,
      health: { avgActiveSeats: 30, seatsPurchased: 40, baselineDeltaPct: 4, tier: "stable", renewalDaysOut: 50 },
      recent: [],
    });
    const result = await callTool(fakeEnv, "get_account_health", { account: "Northwind" });
    expect(result.content[0].text).toContain("Nothing ingested for this account yet");
  });

  it("hands back what was said lately alongside a healthy tier", async () => {
    // The failure this exists to prevent: reporting "stable" on the morning
    // of an angry ticket, because the tier only knows about seat counts.
    vi.mocked(resolveHealth).mockResolvedValueOnce({
      kind: "health",
      account: fakeAccount,
      health: { avgActiveSeats: 38, seatsPurchased: 40, baselineDeltaPct: 3, tier: "stable", renewalDaysOut: 60 },
      recent: [
        {
          source: "intercom",
          sourceRef: "9981",
          url: "https://app.intercom.com/a/apps/abc/conversations/9981",
          occurredAt: "2026-09-13",
          excerpt: "Third time this month the bulk export has failed. This is becoming a problem.",
        },
      ],
    });
    const result = await callTool(fakeEnv, "get_account_health", { account: "Northwind" });
    const text = result.content[0].text;
    expect(text).toContain("stable");
    expect(text).toContain("Lately");
    expect(text).toContain("intercom · 2026-09-13");
    expect(text).toContain("bulk export has failed");
    expect(text).toContain("https://app.intercom.com/a/apps/abc/conversations/9981");
  });

  it("get_account_health surfaces account_not_found as an error with suggestions", async () => {
    vi.mocked(resolveHealth).mockResolvedValueOnce({
      kind: "account_not_found",
      query: "Nortwind",
      sampleNames: ["Northwind", "Lumen Labs"],
    });
    const result = await callTool(fakeEnv, "get_account_health", { account: "Nortwind" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Northwind, Lumen Labs");
  });

  it("ask_about_account requires both account and question", async () => {
    const result = await callTool(fakeEnv, "ask_about_account", { account: "Northwind" });
    expect(result.isError).toBe(true);
  });

  it("ask_about_account returns the answer with numbered sources", async () => {
    vi.mocked(findAccountByName).mockResolvedValueOnce({
      account_id: "1", name: "Northwind", plan: "pro", seats_purchased: 40, renewal_date: "2026-11-01", csm_owner_name: null, csm_owner_slack_id: null, usage_pattern: null,
    });
    vi.mocked(resolveQuestion).mockResolvedValueOnce({
      kind: "question",
      account: { account_id: "1", name: "Northwind", plan: "pro", seats_purchased: 40, renewal_date: "2026-11-01", csm_owner_name: null, csm_owner_slack_id: null, usage_pattern: null },
      question: "why is Northwind declining?",
      answer: "Their admin champion left in August [1].",
      chunks: [{ id: "c1", source: "zoom", occurredAt: "2026-08-14", chunkText: "...", score: 0.9 }],
    });
    const result = await callTool(fakeEnv, "ask_about_account", { account: "Northwind", question: "why is Northwind declining?" });
    expect(result.content[0].text).toContain("Their admin champion left in August [1].");
    expect(result.content[0].text).toContain("[1] zoom · 2026-08-14");
  });

  it("ask_about_account errors when the account isn't found", async () => {
    vi.mocked(findAccountByName).mockResolvedValueOnce(undefined);
    const result = await callTool(fakeEnv, "ask_about_account", { account: "Nowhere", question: "why?" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No account matching");
  });

  it("returns an error for an unknown tool name", async () => {
    const result = await callTool(fakeEnv, "delete_everything", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Unknown tool: delete_everything");
  });
});

describe("get_account_context", () => {
  it("returns excerpts verbatim, with source and date, and never calls a model", async () => {
    vi.mocked(findAccountByName).mockResolvedValueOnce(fakeAccount);
    vi.mocked(retrieveContext).mockResolvedValueOnce([
      { id: "c1", source: "zoom", occurredAt: "2026-08-14", chunkText: "our admin Sarah actually left last month", score: 0.91 },
      { id: "c2", source: "intercom", occurredAt: null, chunkText: "SSO cert expired, blocking new logins", score: 0.77 },
    ]);

    const result = await callTool(fakeEnv, "get_account_context", { account: "Northwind", topic: "champion" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("our admin Sarah actually left last month");
    expect(result.content[0].text).toContain("[1] zoom · 2026-08-14 (relevance 0.91)");
    // no occurredAt — the date segment is omitted rather than printed as null
    expect(result.content[0].text).toContain("[2] intercom (relevance 0.77)");
  });

  it("clamps limit into 1..20 and passes it through to retrieval", async () => {
    vi.mocked(findAccountByName).mockResolvedValue(fakeAccount);
    vi.mocked(retrieveContext).mockResolvedValue([]);

    await callTool(fakeEnv, "get_account_context", { account: "Northwind", topic: "x", limit: 999 });
    expect(vi.mocked(retrieveContext).mock.calls.at(-1)?.[3]).toBe(20);

    await callTool(fakeEnv, "get_account_context", { account: "Northwind", topic: "x", limit: 0 });
    expect(vi.mocked(retrieveContext).mock.calls.at(-1)?.[3]).toBe(1);

    await callTool(fakeEnv, "get_account_context", { account: "Northwind", topic: "x" });
    expect(vi.mocked(retrieveContext).mock.calls.at(-1)?.[3]).toBe(5);
  });

  it("says plainly when nothing relevant is on file, without treating it as an error", async () => {
    vi.mocked(findAccountByName).mockResolvedValueOnce(fakeAccount);
    vi.mocked(retrieveContext).mockResolvedValueOnce([]);
    const result = await callTool(fakeEnv, "get_account_context", { account: "Northwind", topic: "pricing" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("no context has been connected");
  });

  it("requires both account and topic", async () => {
    const result = await callTool(fakeEnv, "get_account_context", { account: "Northwind" });
    expect(result.isError).toBe(true);
  });

  it("reports a retrieval failure instead of throwing", async () => {
    vi.mocked(findAccountByName).mockResolvedValueOnce(fakeAccount);
    vi.mocked(retrieveContext).mockRejectedValueOnce(new Error("vectorize down"));
    const result = await callTool(fakeEnv, "get_account_context", { account: "Northwind", topic: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Couldn't search");
  });
});

describe("explain_answer", () => {
  it("needs something to look up", async () => {
    const result = await callTool(fakeEnv, "explain_answer", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("trace_id or account");
  });

  it("renders the trace for an id", async () => {
    vi.mocked(getAnswerTrace).mockResolvedValueOnce({
      id: "t-1",
      accountId: "1",
      question: "why is Northwind declining?",
      answer: "Their admin left.",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      prompt: "...",
      chunks: [],
      retrievalMs: 40,
      generationMs: 900,
      createdAt: "2026-09-15 10:00:00",
    });
    const result = await callTool(fakeEnv, "explain_answer", { trace_id: "t-1" });
    expect(result.content[0].text).toBe("RENDERED TRACE");
    expect(vi.mocked(renderTrace).mock.calls.at(-1)?.[1]).toEqual({ includePrompt: false });
  });

  it("passes include_prompt through when asked", async () => {
    vi.mocked(getAnswerTrace).mockResolvedValueOnce({
      id: "t-1", accountId: "1", question: "q", answer: "a", provider: "workers-ai",
      model: "m", prompt: "p", chunks: [], retrievalMs: null, generationMs: null, createdAt: "2026-09-15",
    });
    await callTool(fakeEnv, "explain_answer", { trace_id: "t-1", include_prompt: true });
    expect(vi.mocked(renderTrace).mock.calls.at(-1)?.[1]).toEqual({ includePrompt: true });
  });

  it("says plainly that a missing trace has probably expired", async () => {
    vi.mocked(getAnswerTrace).mockResolvedValueOnce(undefined);
    const result = await callTool(fakeEnv, "explain_answer", { trace_id: "gone" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("expire");
  });

  it("falls back to an account's most recent answer", async () => {
    vi.mocked(findAccountByName).mockResolvedValueOnce(fakeAccount);
    vi.mocked(latestAnswerTrace).mockResolvedValueOnce({
      id: "t-9", accountId: "1", question: "q", answer: "a", provider: "openrouter",
      model: "deepseek/deepseek-chat", prompt: "p", chunks: [], retrievalMs: null, generationMs: null, createdAt: "2026-09-15",
    });
    const result = await callTool(fakeEnv, "explain_answer", { account: "Northwind" });
    expect(result.content[0].text).toBe("RENDERED TRACE");
  });

  it("says so when an account has never been asked about", async () => {
    vi.mocked(findAccountByName).mockResolvedValueOnce(fakeAccount);
    vi.mocked(latestAnswerTrace).mockResolvedValueOnce(undefined);
    const result = await callTool(fakeEnv, "explain_answer", { account: "Northwind" });
    expect(result.content[0].text).toContain("No questions have been answered");
    expect(result.isError).toBeFalsy();
  });
});
