/** Salesforce CRM connector — pulls logged activity (calls, emails,
 * meetings, and anything else a CSM records against an Account) into the
 * retriever. Nightly backfill like HubSpot, for the same reason: Salesforce
 * streaming/Platform Events need a lot more setup than a token and a query.
 *
 * Auth is the OAuth 2.0 client-credentials flow — no user in the loop, which
 * is what a background sync wants. Set it up in Salesforce under Setup →
 * External Client Apps (or Connected Apps on older orgs; note that new
 * Connected App creation is disabled by default from Spring '26 onward, so
 * prefer External Client Apps): enable OAuth, tick "Enable Client Credentials
 * Flow", and pick a run-as user whose permissions decide what this connector
 * can see.
 *
 * Reads Task records rather than Notes: in practice the CS-relevant history
 * in Salesforce (logged calls, emails, meeting notes) lands on Task, and it
 * carries a direct AccountId. ContentNote — the modern "enhanced notes"
 * object — needs a ContentDocumentLink join plus base64 decoding and follows
 * separate content sharing rules, so it's deliberately out of scope here;
 * open an issue if your org keeps its CS context there instead.
 *
 * NOTE: implemented from Salesforce's documented REST API — not tested
 * against a live org. If parsing comes up empty, check the API version
 * constant below and the SOQL against your org's field-level security. */

import type { Env } from "../env.js";
import { ingestDocument } from "../rag/ingest.js";
import { resolveAccountId } from "./resolve-account.js";
import { getSettings } from "../settings.js";

/** Salesforce supports older API versions for years, so this is pinned
 * conservatively rather than chasing the newest release. Bump it if you
 * need a field only newer versions expose. */
const API_VERSION = "v61.0";

interface SalesforceTask {
  Id: string;
  Subject: string | null;
  Description: string | null;
  ActivityDate: string | null;
  LastModifiedDate: string;
  AccountId: string | null;
}

interface SalesforceAccount {
  Id: string;
  Name: string;
  Website: string | null;
}

interface QueryResponse<T> {
  totalSize: number;
  done: boolean;
  records: T[];
}

/** Exported for testing: Salesforce's Website field is free text, so it
 * arrives as anything from "acme.com" to "https://www.acme.com/careers?x=1".
 * Returns undefined rather than guessing when there's nothing usable. */
export function domainFromWebsite(website: string | null | undefined): string | undefined {
  if (!website) return undefined;
  const trimmed = website.trim();
  if (!trimmed) return undefined;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname;
  } catch {
    return undefined;
  }
  const cleaned = host.toLowerCase().replace(/^www\./, "");
  return cleaned.includes(".") ? cleaned : undefined;
}

async function getAccessToken(instanceUrl: string, clientId: string, clientSecret: string): Promise<{ token: string; apiHost: string }> {
  const resp = await fetch(`${instanceUrl.replace(/\/+$/, "")}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Salesforce token exchange failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  }
  const json = await resp.json<{ access_token?: string; instance_url?: string }>();
  if (!json.access_token) throw new Error("Salesforce token exchange returned no access_token");
  // instance_url comes back on the token response and is the host every
  // subsequent API call should use — it can differ from the login host.
  return { token: json.access_token, apiHost: (json.instance_url || instanceUrl).replace(/\/+$/, "") };
}

async function soql<T>(apiHost: string, token: string, query: string): Promise<QueryResponse<T>> {
  const resp = await fetch(`${apiHost}/services/data/${API_VERSION}/query/?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    throw new Error(`Salesforce query failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  }
  return resp.json<QueryResponse<T>>();
}

export async function backfillRecentSalesforce(env: Env): Promise<void> {
  const { SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET } = await getSettings(env, [
    "SALESFORCE_INSTANCE_URL",
    "SALESFORCE_CLIENT_ID",
    "SALESFORCE_CLIENT_SECRET",
  ]);
  if (!SALESFORCE_INSTANCE_URL || !SALESFORCE_CLIENT_ID || !SALESFORCE_CLIENT_SECRET) return; // not configured

  const { token, apiHost } = await getAccessToken(SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET);

  const tasks = await soql<SalesforceTask>(
    apiHost,
    token,
    `SELECT Id, Subject, Description, ActivityDate, LastModifiedDate, AccountId
     FROM Task
     WHERE LastModifiedDate >= LAST_N_DAYS:2 AND AccountId != null
     ORDER BY LastModifiedDate DESC
     LIMIT 200`
  );
  if (!tasks.records.length) return;

  // One extra query for every account mentioned, rather than one per task —
  // Website is what resolves a Salesforce account to a Bellwether one.
  const accountIds = [...new Set(tasks.records.map((t) => t.AccountId).filter((id): id is string => !!id))];
  const idList = accountIds.map((id) => `'${id.replace(/'/g, "")}'`).join(", ");
  const accounts = await soql<SalesforceAccount>(apiHost, token, `SELECT Id, Name, Website FROM Account WHERE Id IN (${idList})`);
  const accountById = new Map(accounts.records.map((a) => [a.Id, a]));

  for (const task of tasks.records) {
    try {
      const existing = await env.DB.prepare(`SELECT 1 FROM context_chunks WHERE source = 'salesforce' AND source_ref = ?1 LIMIT 1`)
        .bind(task.Id)
        .first();
      if (existing) continue;

      const text = [task.Subject, task.Description].filter(Boolean).join("\n").trim();
      if (!text) continue;

      const sfAccount = task.AccountId ? accountById.get(task.AccountId) : undefined;
      if (!sfAccount) continue;

      const domain = domainFromWebsite(sfAccount.Website);
      const accountId = await resolveAccountId(env, {
        emails: domain ? [`crm@${domain}`] : [],
        title: sfAccount.Name,
      });
      if (!accountId) continue;

      await ingestDocument(env, {
        accountId,
        source: "salesforce",
        sourceRef: task.Id,
        text,
        occurredAt: (task.ActivityDate || task.LastModifiedDate).slice(0, 10),
      });
    } catch (err) {
      console.error(`salesforce backfill failed for task ${task.Id}`, err);
    }
  }
}
