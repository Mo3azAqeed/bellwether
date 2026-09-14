import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";

/** Contract tests for the Salesforce connector.
 *
 * The fixtures below are the response shapes Salesforce's REST API
 * documentation describes — including the `attributes` envelope every SOQL
 * record carries, which we ignore. They are NOT captures from a live org,
 * because there isn't one to capture from yet. So these lock our end of the
 * contract: the requests we send, and the fields we read out of a documented
 * response. They will catch a wrong field path, a dropped filter, or a
 * refactor that stops using the token's own instance_url. They cannot catch
 * the documentation being wrong about a real org.
 *
 * Replace a fixture with a real captured body the first time someone runs
 * this against an actual Salesforce org, and the tests become the stronger
 * kind without any other change. */

vi.mock("../settings.js", () => ({ getSettings: vi.fn() }));
vi.mock("../rag/ingest.js", () => ({ ingestDocument: vi.fn() }));
vi.mock("./resolve-account.js", () => ({ resolveAccountId: vi.fn() }));

const { getSettings } = await import("../settings.js");
const { ingestDocument } = await import("../rag/ingest.js");
const { resolveAccountId } = await import("./resolve-account.js");
const { backfillRecentSalesforce } = await import("./salesforce.js");

const CONFIG = {
  SALESFORCE_INSTANCE_URL: "https://acme.my.salesforce.com",
  SALESFORCE_CLIENT_ID: "3MVG9client",
  SALESFORCE_CLIENT_SECRET: "shhh",
};

/** The token response. `instance_url` deliberately differs from the
 * configured login host — Salesforce returns the host every subsequent call
 * must use, and they are not always the same. */
const TOKEN_RESPONSE = {
  access_token: "00Dxx0000001gPz!AQ4AQJ9example",
  instance_url: "https://acme-api.my.salesforce.com",
  id: "https://login.salesforce.com/id/00Dxx0000001gPzEAI/005xx000001SvogAAC",
  token_type: "Bearer",
  issued_at: "1789000000000",
  signature: "cGxhY2Vob2xkZXI=",
};

function task(over: Record<string, unknown> = {}) {
  return {
    attributes: { type: "Task", url: "/services/data/v61.0/sobjects/Task/00T5g00000ABCDE" },
    Id: "00T5g00000ABCDE",
    Subject: "Call: quarterly check-in",
    Description: "Maya raised that their admin left in August.",
    ActivityDate: "2026-09-08",
    LastModifiedDate: "2026-09-09T11:04:22.000+0000",
    AccountId: "0015g00000XYZAB",
    ...over,
  };
}

function account(over: Record<string, unknown> = {}) {
  return {
    attributes: { type: "Account", url: "/services/data/v61.0/sobjects/Account/0015g00000XYZAB" },
    Id: "0015g00000XYZAB",
    Name: "Northwind",
    Website: "https://www.northwind.io/",
    ...over,
  };
}

function queryResponse(records: unknown[]) {
  return { totalSize: records.length, done: true, records };
}

let calls: { url: string; init?: RequestInit }[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Routes by what the URL contains, so a test only has to describe the
 * responses it cares about. An unrouted request fails loudly rather than
 * returning undefined and surfacing as a confusing parse error later. */
function stubFetch(routes: { token?: Response | (() => Response); tasks?: unknown[]; accounts?: unknown[] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes("/services/oauth2/token")) {
        const t = routes.token;
        return typeof t === "function" ? t() : (t ?? json(TOKEN_RESPONSE));
      }
      if (url.includes("/query/")) {
        const q = decodeURIComponent(url.split("?q=")[1] ?? "");
        if (/FROM\s+Task/i.test(q)) return json(queryResponse(routes.tasks ?? []));
        if (/FROM\s+Account/i.test(q)) return json(queryResponse(routes.accounts ?? []));
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

/** The URL of the nth request whose path matches, for asserting on what we
 * actually sent rather than on what we think we sent. */
function requestMatching(pattern: RegExp): { url: string; init?: RequestInit } | undefined {
  return calls.find((c) => pattern.test(c.url));
}

function soqlFor(objectName: string): string {
  const call = calls.find((c) => c.url.includes("/query/") && new RegExp(`FROM%20*\\s*${objectName}`, "i").test(c.url));
  return call ? decodeURIComponent(call.url.split("?q=")[1] ?? "") : "";
}

beforeEach(() => {
  calls = [];
  vi.mocked(getSettings).mockResolvedValue(CONFIG);
  vi.mocked(resolveAccountId).mockResolvedValue("acct-001");
  vi.mocked(ingestDocument).mockResolvedValue({ chunksStored: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("backfillRecentSalesforce — when it runs at all", () => {
  it("makes no request when the connector isn't configured", async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    stubFetch({});
    await backfillRecentSalesforce(fakeEnv());
    expect(calls).toHaveLength(0);
  });

  it("makes no request when only some of the three credentials are set", async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...CONFIG, SALESFORCE_CLIENT_SECRET: undefined });
    stubFetch({});
    await backfillRecentSalesforce(fakeEnv());
    expect(calls).toHaveLength(0);
  });
});

describe("backfillRecentSalesforce — the requests it sends", () => {
  it("exchanges client credentials as a form post at the documented token path", async () => {
    stubFetch({ tasks: [] });
    await backfillRecentSalesforce(fakeEnv());

    const token = requestMatching(/oauth2\/token/);
    expect(token?.url).toBe("https://acme.my.salesforce.com/services/oauth2/token");
    expect(token?.init?.method).toBe("POST");
    expect((token?.init?.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");

    const body = new URLSearchParams(String(token?.init?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "client_credentials",
      client_id: CONFIG.SALESFORCE_CLIENT_ID,
      client_secret: CONFIG.SALESFORCE_CLIENT_SECRET,
    });
  });

  it("calls the API on the host the token response names, not the configured login host", async () => {
    stubFetch({ tasks: [task()], accounts: [account()] });
    await backfillRecentSalesforce(fakeEnv());

    const queries = calls.filter((c) => c.url.includes("/query/"));
    expect(queries).not.toHaveLength(0);
    for (const q of queries) {
      expect(q.url.startsWith("https://acme-api.my.salesforce.com/")).toBe(true);
    }
  });

  it("queries the documented versioned endpoint with a bearer token", async () => {
    stubFetch({ tasks: [] });
    await backfillRecentSalesforce(fakeEnv());

    const query = requestMatching(/\/query\//);
    expect(query?.url).toContain("/services/data/v61.0/query/?q=");
    expect((query?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN_RESPONSE.access_token}`);
  });

  it("asks for every Task field it later reads, windowed and capped", async () => {
    stubFetch({ tasks: [] });
    await backfillRecentSalesforce(fakeEnv());

    const q = soqlFor("Task");
    for (const field of ["Id", "Subject", "Description", "ActivityDate", "LastModifiedDate", "AccountId"]) {
      expect(q).toContain(field);
    }
    expect(q).toContain("LAST_N_DAYS:2");
    expect(q).toContain("AccountId != null");
    expect(q).toContain("LIMIT 200");
  });

  it("looks up the accounts in one query rather than one per task", async () => {
    stubFetch({
      tasks: [task({ Id: "t1" }), task({ Id: "t2" }), task({ Id: "t3", AccountId: "0015g00000OTHER" })],
      accounts: [account(), account({ Id: "0015g00000OTHER", Name: "Ardent", Website: "ardent.co" })],
    });
    await backfillRecentSalesforce(fakeEnv());

    const accountQueries = calls.filter((c) => c.url.includes("/query/") && /FROM%20+Account|FROM\s+Account/i.test(decodeURIComponent(c.url)));
    expect(accountQueries).toHaveLength(1);

    const q = soqlFor("Account");
    expect(q).toContain("'0015g00000XYZAB'");
    expect(q).toContain("'0015g00000OTHER'");
  });
});

describe("backfillRecentSalesforce — what it does with the response", () => {
  it("ingests a logged task under the account its website resolves to", async () => {
    stubFetch({ tasks: [task()], accounts: [account()] });
    await backfillRecentSalesforce(fakeEnv());

    expect(resolveAccountId).toHaveBeenCalledWith(expect.anything(), {
      emails: ["crm@northwind.io"],
      title: "Northwind",
    });
    expect(ingestDocument).toHaveBeenCalledWith(expect.anything(), {
      accountId: "acct-001",
      source: "salesforce",
      sourceRef: "00T5g00000ABCDE",
      text: "Call: quarterly check-in\nMaya raised that their admin left in August.",
      occurredAt: "2026-09-08",
    });
  });

  it("dates a task by when the activity happened, falling back to when it was edited", async () => {
    stubFetch({ tasks: [task({ ActivityDate: null })], accounts: [account()] });
    await backfillRecentSalesforce(fakeEnv());

    expect(ingestDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ occurredAt: "2026-09-09" }));
  });

  it("resolves by name alone when the account has no usable website", async () => {
    stubFetch({ tasks: [task()], accounts: [account({ Website: null })] });
    await backfillRecentSalesforce(fakeEnv());

    expect(resolveAccountId).toHaveBeenCalledWith(expect.anything(), { emails: [], title: "Northwind" });
  });

  it("skips a task already ingested rather than duplicating it", async () => {
    stubFetch({ tasks: [task()], accounts: [account()] });
    await backfillRecentSalesforce(fakeEnv(["00T5g00000ABCDE"]));

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("skips a task with no subject and no description", async () => {
    stubFetch({ tasks: [task({ Subject: null, Description: null })], accounts: [account()] });
    await backfillRecentSalesforce(fakeEnv());

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("skips a task whose account the second query didn't return", async () => {
    stubFetch({ tasks: [task()], accounts: [] });
    await backfillRecentSalesforce(fakeEnv());

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("skips a task Bellwether has no matching account for", async () => {
    vi.mocked(resolveAccountId).mockResolvedValue(undefined);
    stubFetch({ tasks: [task()], accounts: [account()] });
    await backfillRecentSalesforce(fakeEnv());

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("keeps going when one task fails to ingest", async () => {
    vi.mocked(ingestDocument)
      .mockRejectedValueOnce(new Error("embedding service is down"))
      .mockResolvedValue({ chunksStored: 1 });
    stubFetch({ tasks: [task({ Id: "t1" }), task({ Id: "t2" })], accounts: [account()] });

    await expect(backfillRecentSalesforce(fakeEnv())).resolves.toBeUndefined();
    expect(ingestDocument).toHaveBeenCalledTimes(2);
  });
});

describe("backfillRecentSalesforce — failures worth seeing", () => {
  it("throws with the status when the token exchange is rejected", async () => {
    stubFetch({ token: () => new Response("invalid_client_id", { status: 401 }) });

    await expect(backfillRecentSalesforce(fakeEnv())).rejects.toThrow(/HTTP 401/);
  });

  it("throws when the token response carries no access_token", async () => {
    stubFetch({ token: () => json({ instance_url: "https://acme-api.my.salesforce.com" }) });

    await expect(backfillRecentSalesforce(fakeEnv())).rejects.toThrow(/no access_token/);
  });

  it("stops before sending an empty IN () clause when no task carries an account", async () => {
    // The SOQL filters AccountId != null, so this shouldn't happen — but a
    // malformed query throws and takes the whole run with it, and the guard
    // costs one comparison.
    stubFetch({ tasks: [task({ AccountId: null })] });

    await expect(backfillRecentSalesforce(fakeEnv())).resolves.toBeUndefined();
    expect(soqlFor("Account")).toBe("");
  });
});
