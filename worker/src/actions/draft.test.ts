import { describe, expect, it } from "vitest";
import { buildTicketDraft, renderTicketAdf, renderTicketMarkdown, ticketTitle } from "./draft.js";
import { resolveProvider } from "./tracker.js";
import type { RetrievedChunk } from "../rag/retrieve.js";

const chunk = (over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  id: "c1",
  source: "zendesk",
  sourceRef: "4412",
  url: "https://northwind.zendesk.com/agent/tickets/4412",
  occurredAt: "2026-09-06",
  chunkText: "SSO certificate expired — new users cannot log in at all.",
  score: 0.8,
  ...over,
});

describe("ticketTitle", () => {
  it("leads with the account so a backlog stays scannable", () => {
    expect(ticketTitle("Northwind", "SSO cert expiry blocks new logins")).toBe(
      "[Northwind] SSO cert expiry blocks new logins"
    );
  });

  it("drops the trailing question mark a CSM will type", () => {
    expect(ticketTitle("Northwind", "why does SSO keep expiring?")).toBe("[Northwind] why does SSO keep expiring");
  });

  it("cuts a long topic on a word boundary", () => {
    const title = ticketTitle("Northwind", "a ".repeat(200));
    expect(title.length).toBeLessThanOrEqual(110);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("buildTicketDraft", () => {
  it("carries the customer's words verbatim, with their source and link", () => {
    const draft = buildTicketDraft({
      accountName: "Northwind",
      topic: "SSO expiry",
      summary: "Blocking new logins.",
      chunks: [chunk()],
    });
    expect(draft.evidence[0]).toEqual({
      quote: "SSO certificate expired — new users cannot log in at all.",
      source: "zendesk",
      occurredAt: "2026-09-06",
      url: "https://northwind.zendesk.com/agent/tickets/4412",
    });
  });

  it("caps how much evidence one ticket carries", () => {
    const draft = buildTicketDraft({
      accountName: "N",
      topic: "t",
      summary: "s",
      chunks: Array.from({ length: 9 }, (_, i) => chunk({ id: `c${i}` })),
    });
    expect(draft.evidence).toHaveLength(5);
  });

  it("truncates a very long record rather than pasting a whole transcript", () => {
    const draft = buildTicketDraft({ accountName: "N", topic: "t", summary: "s", chunks: [chunk({ chunkText: "x".repeat(900) })] });
    expect(draft.evidence[0].quote.endsWith("…")).toBe(true);
    expect(draft.evidence[0].quote.length).toBeLessThan(500);
  });
});

describe("renderTicketMarkdown", () => {
  it("quotes the customer and links the record", () => {
    const md = renderTicketMarkdown(
      buildTicketDraft({ accountName: "Northwind", topic: "SSO", summary: "Blocking logins.", chunks: [chunk()], facts: ["pro plan", "40 seats"] })
    );
    expect(md).toContain("Blocking logins.");
    expect(md).toContain("**Northwind:** pro plan · 40 seats");
    expect(md).toContain("> SSO certificate expired");
    expect(md).toContain("[zendesk · 2026-09-06](https://northwind.zendesk.com/agent/tickets/4412)");
  });

  it("says outright when there's no evidence rather than looking complete", () => {
    const md = renderTicketMarkdown(buildTicketDraft({ accountName: "N", topic: "t", summary: "s", chunks: [] }));
    expect(md).toContain("No customer records were attached");
  });

  it("names the source without a link when the record isn't linkable", () => {
    const md = renderTicketMarkdown(buildTicketDraft({ accountName: "N", topic: "t", summary: "s", chunks: [chunk({ url: null })] }));
    expect(md).toContain("— zendesk · 2026-09-06");
    expect(md).not.toContain("](");
  });
});

describe("renderTicketAdf", () => {
  // Jira Cloud v3 rejects a plain string in `description`; it has to be this
  // nested document shape, so the structure itself is the contract.
  const doc = renderTicketAdf(
    buildTicketDraft({ accountName: "Northwind", topic: "SSO", summary: "Blocking logins.", chunks: [chunk()] })
  ) as { type: string; version: number; content: Record<string, unknown>[] };

  it("is a versioned ADF document", () => {
    expect(doc.type).toBe("doc");
    expect(doc.version).toBe(1);
    expect(Array.isArray(doc.content)).toBe(true);
  });

  it("puts the quote in a blockquote and the source in a link mark", () => {
    const json = JSON.stringify(doc);
    expect(json).toContain('"blockquote"');
    expect(json).toContain("SSO certificate expired");
    expect(json).toContain('"href":"https://northwind.zendesk.com/agent/tickets/4412"');
  });

  it("never emits a bare string where ADF expects nodes", () => {
    for (const node of doc.content) {
      expect(typeof node).toBe("object");
      expect(node).toHaveProperty("type");
    }
  });
});

describe("resolveProvider", () => {
  const linear = { linearApiKey: "k", linearTeamId: "t" };
  const jira = { jiraSiteUrl: "https://x.atlassian.net", jiraEmail: "a@b.c", jiraApiToken: "t", jiraProjectKey: "ENG" };

  it("uses whichever one is fully configured", () => {
    expect(resolveProvider(linear)).toBe("linear");
    expect(resolveProvider(jira)).toBe("jira");
  });

  it("obeys an explicit choice, and refuses it when that one is half-configured", () => {
    expect(resolveProvider({ ...linear, ...jira, provider: "jira" })).toBe("jira");
    expect(resolveProvider({ ...linear, provider: "jira" })).toBeUndefined();
  });

  it("returns nothing rather than trying a half-configured tracker", () => {
    expect(resolveProvider({ linearApiKey: "k" })).toBeUndefined();
    expect(resolveProvider({ ...jira, jiraProjectKey: undefined })).toBeUndefined();
    expect(resolveProvider({})).toBeUndefined();
  });
});
