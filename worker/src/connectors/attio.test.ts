import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";

/** Contract tests for the Attio connector.
 *
 * The fixtures are the v2 REST shapes Attio's documentation describes: a
 * note's compound `id` object, the historised-array form every attribute
 * value takes, and the `data` envelope on both endpoints. They are NOT
 * captures from a live workspace, because there isn't one to capture from
 * yet — so they lock our end of the contract (the requests we send, the
 * fields we read) rather than proving the documentation matches reality.
 *
 * Swap in a real captured body the first time this runs against an actual
 * workspace and the tests get stronger with no other change. */

vi.mock("../settings.js", () => ({ getSetting: vi.fn() }));
vi.mock("../rag/ingest.js", () => ({ ingestDocument: vi.fn() }));
vi.mock("./resolve-account.js", () => ({ resolveAccountId: vi.fn() }));

const { getSetting } = await import("../settings.js");
const { ingestDocument } = await import("../rag/ingest.js");
const { resolveAccountId } = await import("./resolve-account.js");
const { backfillRecentAttio } = await import("./attio.js");

const TOKEN = "attio_tok_example";

function note(over: Record<string, unknown> = {}) {
  return {
    id: {
      workspace_id: "8d1f0e6a-0000-4000-8000-000000000001",
      note_id: "n-4412",
    },
    parent_object: "companies",
    parent_record_id: "rec-northwind",
    title: "QBR — Northwind",
    content_plaintext: "Maya flagged that their admin left in August.",
    content_markdown: "Maya flagged that their admin left in **August**.",
    created_at: "2026-09-03T10:14:00.000000000Z",
    created_by_actor: { id: "usr-1", type: "workspace-member" },
    ...over,
  };
}

/** Attio attribute values are arrays of historised entries, current first. */
function companyRecord(values: Record<string, unknown[]>) {
  return {
    data: {
      id: {
        workspace_id: "8d1f0e6a-0000-4000-8000-000000000001",
        object_id: "obj-companies",
        record_id: "rec-northwind",
      },
      created_at: "2026-01-04T09:00:00.000000000Z",
      values,
    },
  };
}

const NORTHWIND = companyRecord({
  name: [{ active_from: "2026-01-04T09:00:00.000000000Z", active_until: null, attribute_type: "text", value: "Northwind" }],
  domains: [
    {
      active_from: "2026-01-04T09:00:00.000000000Z",
      active_until: null,
      attribute_type: "domain",
      domain: "northwind.io",
      root_domain: "northwind.io",
    },
  ],
});

let calls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let authHeaders: (string | undefined)[] = [];

/** `notePages` is served one page per request, in order; anything left over
 * after the pages run out is an empty page. `company` is looked up by the
 * record id in the URL. */
function stubFetch(opts: { notePages?: unknown[][]; company?: (recordId: string) => Response }) {
  const pages = [...(opts.notePages ?? [])];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      authHeaders.push((init?.headers as Record<string, string> | undefined)?.Authorization);

      if (url.includes("/notes?")) {
        return json({ data: pages.shift() ?? [] });
      }
      if (url.includes("/objects/companies/records/")) {
        const recordId = url.split("/records/")[1];
        return opts.company ? opts.company(recordId) : json(NORTHWIND);
      }
      throw new Error(`unrouted request in test: ${url}`);
    })
  );
}

function fakeEnv(alreadyIngested: string[] = []): Env {
  const seen = new Set(alreadyIngested);
  return {
    DB: {
      prepare: () => ({
        bind: (ref: string) => ({ first: async () => (seen.has(ref) ? { 1: 1 } : null) }),
      }),
    },
  } as unknown as Env;
}

const fullPage = (n: number) => Array.from({ length: 50 }, (_, i) => note({ id: { note_id: `page${n}-${i}` } }));

beforeEach(() => {
  calls = [];
  authHeaders = [];
  vi.mocked(getSetting).mockResolvedValue(TOKEN);
  vi.mocked(resolveAccountId).mockResolvedValue("acct-001");
  vi.mocked(ingestDocument).mockResolvedValue({ chunksStored: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("backfillRecentAttio — when it runs at all", () => {
  it("makes no request when no API key is configured", async () => {
    vi.mocked(getSetting).mockResolvedValue(undefined);
    stubFetch({});
    await backfillRecentAttio(fakeEnv());
    expect(calls).toHaveLength(0);
  });
});

describe("backfillRecentAttio — the requests it sends", () => {
  it("reads notes from the documented v2 endpoint with a bearer token", async () => {
    stubFetch({ notePages: [[note()]] });
    await backfillRecentAttio(fakeEnv());

    expect(calls[0]).toBe("https://api.attio.com/v2/notes?limit=50&offset=0");
    expect(authHeaders[0]).toBe(`Bearer ${TOKEN}`);
  });

  it("stops paging as soon as a page comes back short", async () => {
    stubFetch({ notePages: [fullPage(1), [note({ id: { note_id: "last" } })]] });
    await backfillRecentAttio(fakeEnv());

    const noteCalls = calls.filter((u) => u.includes("/notes?"));
    expect(noteCalls).toEqual([
      "https://api.attio.com/v2/notes?limit=50&offset=0",
      "https://api.attio.com/v2/notes?limit=50&offset=50",
    ]);
  });

  it("caps a busy workspace at five pages rather than paging forever", async () => {
    stubFetch({ notePages: [fullPage(1), fullPage(2), fullPage(3), fullPage(4), fullPage(5), fullPage(6)] });
    await backfillRecentAttio(fakeEnv());

    const noteCalls = calls.filter((u) => u.includes("/notes?"));
    expect(noteCalls).toHaveLength(5);
    expect(noteCalls.at(-1)).toContain("offset=200");
  });

  it("looks a company up once however many of its notes are in the batch", async () => {
    stubFetch({
      notePages: [[note({ id: { note_id: "n1" } }), note({ id: { note_id: "n2" } }), note({ id: { note_id: "n3" } })]],
    });
    await backfillRecentAttio(fakeEnv());

    expect(calls.filter((u) => u.includes("/objects/companies/records/"))).toHaveLength(1);
  });
});

describe("backfillRecentAttio — what it does with the response", () => {
  it("ingests a company note under the account its domain resolves to", async () => {
    stubFetch({ notePages: [[note()]] });
    await backfillRecentAttio(fakeEnv());

    expect(resolveAccountId).toHaveBeenCalledWith(expect.anything(), {
      emails: ["crm@northwind.io"],
      title: "Northwind",
    });
    expect(ingestDocument).toHaveBeenCalledWith(expect.anything(), {
      accountId: "acct-001",
      source: "attio",
      sourceRef: "n-4412",
      text: "QBR — Northwind\nMaya flagged that their admin left in August.",
      occurredAt: "2026-09-03",
    });
  });

  it("ignores notes written on people and deals, which don't map to an account", async () => {
    stubFetch({
      notePages: [[note({ parent_object: "people", id: { note_id: "p1" } }), note({ parent_object: "deals", id: { note_id: "d1" } })]],
    });
    await backfillRecentAttio(fakeEnv());

    expect(ingestDocument).not.toHaveBeenCalled();
    expect(calls.some((u) => u.includes("/objects/companies/records/"))).toBe(false);
  });

  it("reads the domain whether the workspace returns domain, full_domain, or a plain value", async () => {
    for (const [shape, entry] of [
      ["domain", { domain: "northwind.io" }],
      ["full_domain", { full_domain: "northwind.io" }],
      ["value", { value: "northwind.io" }],
    ] as const) {
      vi.clearAllMocks();
      vi.mocked(resolveAccountId).mockResolvedValue("acct-001");
      vi.mocked(ingestDocument).mockResolvedValue({ chunksStored: 1 });
      vi.mocked(getSetting).mockResolvedValue(TOKEN);
      stubFetch({
        notePages: [[note()]],
        company: () => json(companyRecord({ name: [{ value: "Northwind" }], domains: [entry] })),
      });

      await backfillRecentAttio(fakeEnv());
      expect(resolveAccountId, `domains entry shaped as ${shape}`).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ emails: ["crm@northwind.io"] })
      );
    }
  });

  it("falls back to the note's own text as the title when the company has no name", async () => {
    stubFetch({ notePages: [[note()]], company: () => json(companyRecord({ domains: [{ domain: "northwind.io" }] })) });
    await backfillRecentAttio(fakeEnv());

    expect(resolveAccountId).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: expect.stringContaining("QBR") })
    );
  });

  it("skips a note already ingested rather than duplicating it", async () => {
    stubFetch({ notePages: [[note()]] });
    await backfillRecentAttio(fakeEnv(["n-4412"]));

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("skips an empty note", async () => {
    stubFetch({ notePages: [[note({ title: null, content_plaintext: null })]] });
    await backfillRecentAttio(fakeEnv());

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("leaves occurredAt unset rather than inventing a date", async () => {
    stubFetch({ notePages: [[note({ created_at: null })]] });
    await backfillRecentAttio(fakeEnv());

    expect(ingestDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ occurredAt: undefined }));
  });

  it("keeps going when one note fails", async () => {
    vi.mocked(ingestDocument)
      .mockRejectedValueOnce(new Error("embedding service is down"))
      .mockResolvedValue({ chunksStored: 1 });
    stubFetch({ notePages: [[note({ id: { note_id: "n1" } }), note({ id: { note_id: "n2" } })]] });

    await expect(backfillRecentAttio(fakeEnv())).resolves.toBeUndefined();
    expect(ingestDocument).toHaveBeenCalledTimes(2);
  });

  it("surfaces an API failure rather than swallowing it into an empty run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));

    await expect(backfillRecentAttio(fakeEnv())).rejects.toThrow(/HTTP 401/);
  });
});
