/** Filing an engineering ticket — Bellwether's first write.
 *
 * Everything before this reads. Reads are forgiving: a wrong query returns
 * nothing and you try again. A ticket is not — it lands in someone's
 * backlog, notifies a team, and can't be quietly un-filed. So two rules
 * hold here and are enforced by shape, not by discipline:
 *
 *   1. Nothing is ever filed that a human hasn't seen. The drafting path
 *      (src/actions/draft.ts, and the draft_engineering_ticket tool) writes
 *      nothing at all; filing takes the title and body as explicit
 *      arguments, so whoever approves it has read the exact text.
 *   2. The connector reports what it created — key and URL — rather than
 *      "done". An action you can't check is the thing this product exists
 *      to argue against.
 *
 * Provider-agnostic in the same way src/usage.ts is: one interface, the
 * credentials decide which implementation runs.
 *
 * NOTE: both providers are implemented from published API documentation and
 * have not been run against a live workspace. That matters more here than
 * it did for the read-only CRM connectors, because the failure mode is a
 * malformed write rather than an empty read — so the first real use should
 * be a throwaway project. */

import type { Env } from "../env.js";
import { getSettings } from "../settings.js";
import { renderTicketAdf, renderTicketMarkdown, type TicketDraft } from "./draft.js";

export type TrackerProvider = "linear" | "jira";

export interface CreatedTicket {
  provider: TrackerProvider;
  /** What a human calls it: "ENG-412". */
  key: string;
  url: string;
}

const TRACKER_SETTING_KEYS = [
  "TRACKER_PROVIDER",
  "LINEAR_API_KEY",
  "LINEAR_TEAM_ID",
  "JIRA_SITE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_PROJECT_KEY",
  "JIRA_ISSUE_TYPE",
];

export interface TrackerConfig {
  provider?: TrackerProvider;
  linearApiKey?: string;
  linearTeamId?: string;
  jiraSiteUrl?: string;
  jiraEmail?: string;
  jiraApiToken?: string;
  jiraProjectKey?: string;
  jiraIssueType?: string;
}

/** Which tracker is actually usable, given what's configured. Explicit
 * TRACKER_PROVIDER wins; otherwise whichever one has a complete set of
 * credentials. Returns undefined rather than half-configuring. */
export function resolveProvider(config: TrackerConfig): TrackerProvider | undefined {
  const linearReady = !!(config.linearApiKey && config.linearTeamId);
  const jiraReady = !!(config.jiraSiteUrl && config.jiraEmail && config.jiraApiToken && config.jiraProjectKey);

  if (config.provider === "linear") return linearReady ? "linear" : undefined;
  if (config.provider === "jira") return jiraReady ? "jira" : undefined;
  if (linearReady) return "linear";
  if (jiraReady) return "jira";
  return undefined;
}

export async function trackerConfig(env: Env): Promise<TrackerConfig> {
  const s = await getSettings(env, TRACKER_SETTING_KEYS);
  const provider = s.TRACKER_PROVIDER === "linear" || s.TRACKER_PROVIDER === "jira" ? s.TRACKER_PROVIDER : undefined;
  return {
    provider,
    linearApiKey: s.LINEAR_API_KEY,
    linearTeamId: s.LINEAR_TEAM_ID,
    jiraSiteUrl: s.JIRA_SITE_URL,
    jiraEmail: s.JIRA_EMAIL,
    jiraApiToken: s.JIRA_API_TOKEN,
    jiraProjectKey: s.JIRA_PROJECT_KEY,
    jiraIssueType: s.JIRA_ISSUE_TYPE,
  };
}

interface LinearResponse {
  data?: {
    issueCreate?: { success?: boolean; issue?: { identifier?: string; url?: string } };
  };
  errors?: { message?: string }[];
}

/** Linear's GraphQL API. A personal API key goes in Authorization *raw* —
 * no "Bearer" prefix, unlike almost everything else here. */
async function createLinearIssue(config: TrackerConfig, draft: TicketDraft): Promise<CreatedTicket> {
  const resp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: config.linearApiKey as string,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { identifier url } }
      }`,
      variables: {
        input: {
          teamId: config.linearTeamId,
          title: draft.title,
          description: renderTicketMarkdown(draft),
        },
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Linear API failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  }

  const json = await resp.json<LinearResponse>();
  // GraphQL answers 200 with an errors array, so a non-ok status isn't the
  // only failure to check for.
  if (json.errors?.length) {
    throw new Error(`Linear rejected the issue: ${json.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
  }
  const issue = json.data?.issueCreate?.issue;
  if (!json.data?.issueCreate?.success || !issue?.identifier || !issue.url) {
    throw new Error("Linear reported no issue created.");
  }
  return { provider: "linear", key: issue.identifier, url: issue.url };
}

/** Jira Cloud v3. Basic auth with the account email and an API token, and
 * `description` must be Atlassian Document Format — a plain string is
 * rejected by this API version. */
async function createJiraIssue(config: TrackerConfig, draft: TicketDraft): Promise<CreatedTicket> {
  const site = (config.jiraSiteUrl as string).trim().replace(/\/+$/, "");
  const auth = btoa(`${config.jiraEmail}:${config.jiraApiToken}`);

  const resp = await fetch(`${site}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: config.jiraProjectKey },
        summary: draft.title,
        description: renderTicketAdf(draft),
        issuetype: { name: config.jiraIssueType || "Task" },
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Jira API failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  }

  const json = await resp.json<{ key?: string }>();
  if (!json.key) throw new Error("Jira reported no issue key.");
  // Jira's response gives an API URL; the browse URL is what a human wants.
  return { provider: "jira", key: json.key, url: `${site}/browse/${json.key}` };
}

export async function createTicket(env: Env, draft: TicketDraft): Promise<CreatedTicket> {
  const config = await trackerConfig(env);
  const provider = resolveProvider(config);

  if (!provider) {
    throw new Error(
      "No issue tracker is configured. Set LINEAR_API_KEY + LINEAR_TEAM_ID, or JIRA_SITE_URL + JIRA_EMAIL + JIRA_API_TOKEN + JIRA_PROJECT_KEY."
    );
  }

  return provider === "linear" ? createLinearIssue(config, draft) : createJiraIssue(config, draft);
}
