/** A minimal MCP (Model Context Protocol) server, exposed at POST /mcp, so
 * the same account context that answers @Bell in Slack/Teams can be queried
 * from a coding agent (Claude Code, Cursor, Codex, OpenCode — anything that
 * speaks MCP) too. Each tool below is a thin wrapper over bot-logic.ts's
 * existing resolution functions, not new logic — Slack, Teams, and MCP all
 * answer from the same brain.
 *
 * Hand-rolled rather than pulling in @modelcontextprotocol/sdk: the surface
 * this needs (initialize, tools/list, tools/call, nothing stateful) is small
 * enough that a dependency buys little and this stays consistent with the
 * rest of the app hand-rolling its protocol code (see src/slack/verify.ts).
 * Runs stateless over HTTP — one JSON-RPC request in, one response out, no
 * SSE stream, no session to keep between calls. */

import type { Env } from "../env.js";
import { allDbAccounts, findAccountByName } from "../db.js";
import { resolveHealth, resolveQuestion } from "../bot-logic.js";
import { retrieveContext } from "../rag/retrieve.js";
import { recentLines } from "../rag/recent.js";
import { buildCitations, citationLines, unverifiedQuotes } from "../rag/citation.js";
import { getAnswerTrace, latestAnswerTrace, renderTrace } from "../rag/trace.js";
import { buildTimeline } from "../timeline/data.js";
import { renderTimelineText } from "../timeline/render.js";
import { buildTicketDraft, renderTicketMarkdown } from "../actions/draft.js";
import { createTicket, resolveProvider, trackerConfig } from "../actions/tracker.js";
import { saveDraft, getDraft, listDrafts, markFiled, discardDraft } from "../actions/store.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "bellwether";
const SERVER_VERSION = "0.1.0";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolContent {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_accounts",
    description:
      "List the customer accounts Bellwether is tracking, optionally filtered by a name substring. Use this to find the exact account name before calling get_account_health or ask_about_account.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional substring to filter account names by." },
      },
    },
  },
  {
    name: "get_account_health",
    description:
      "Get an account's current usage health: active seats against its own baseline, health tier (stable / watch / at_risk), and days to renewal.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "The account name, or enough of it to match uniquely." },
      },
      required: ["account"],
    },
  },
  {
    name: "ask_about_account",
    description:
      'Ask a free-form question about an account (for example "why is X declining?"). Retrieves relevant ingested context — call transcripts, support tickets, CRM notes — and answers only from what it finds, with citations. Costs one small LLM call against whichever key this Bellwether deployment is configured with; use get_account_context instead if you would rather reason over the raw material yourself.',
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "The account name, or enough of it to match uniquely." },
        question: { type: "string", description: "The question to ask about this account." },
      },
      required: ["account", "question"],
    },
  },
  {
    name: "get_account_context",
    description:
      "Retrieve the raw source material Bellwether holds on an account for a topic — call transcripts, support tickets, CRM notes — verbatim, with no AI summarization in between. Nothing is sent to a language model server-side, so this is the cheapest way to get account context and lets you do the reasoning yourself.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "The account name, or enough of it to match uniquely." },
        topic: {
          type: "string",
          description: "What to search their history for — a question or a few keywords. Used for semantic search, not as a prompt.",
        },
        limit: { type: "number", description: "How many excerpts to return (default 5, max 20)." },
      },
      required: ["account", "topic"],
    },
  },
  {
    name: "get_account_timeline",
    description:
      "Everything known about an account on one axis: time. Source records (calls, tickets, CRM notes) with a link into each original, the readings where the health tier actually moved, and the questions Bell has been asked with what it built each answer from. Use it before a call, or whenever the question is 'what has actually been happening here' rather than one specific thing. Costs nothing; reads stored rows.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Account name or a close match." },
        limit: { type: "number", description: "How many entries to return, newest first (default 25, max 100)." },
      },
      required: ["account"],
    },
  },
  {
    name: "draft_engineering_ticket",
    description:
      "Draft an engineering ticket from an account's context and SAVE IT AS A DRAFT. Retrieves what the customer actually said about a topic and builds a title and body carrying their verbatim words with a link to each record. Nothing is sent to Linear or Jira — the draft waits for a human to read it. Returns a draft id.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Account name or a close match." },
        topic: { type: "string", description: "What the ticket is about — used to retrieve the relevant records, and as the title." },
        summary: { type: "string", description: "Optional: your own framing of why this is being filed." },
      },
      required: ["account", "topic"],
    },
  },
  {
    name: "list_ticket_drafts",
    description:
      "List saved ticket drafts, newest first — by default the ones still waiting on a human. Shows each draft's id, account, title and status, so a person can read one before deciding whether it should be filed.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "pending (default), filed, or discarded." },
        account: { type: "string", description: "Optional: only drafts for this account." },
        limit: { type: "number", description: "How many to return (default 20, max 100)." },
      },
    },
  },
  {
    name: "file_ticket_draft",
    description:
      "File a saved draft into the configured tracker (Linear or Jira). THIS IS THE ONLY TOOL THAT WRITES TO A TRACKER, it files the stored text verbatim, and it requires an explicit human approval — never call it on your own initiative or to 'tidy up' pending drafts. Show the draft to the person first and call this only once they have said to file it. Pass action 'discard' instead to throw a draft away.",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string", description: "The id returned by draft_engineering_ticket or list_ticket_drafts." },
        action: { type: "string", description: "'file' to create it in the tracker, or 'discard' to close it unfiled." },
        approved_by: {
          type: "string",
          description: "Who approved it — the person's name as they gave it. Required for 'file'; recorded so an unexplained ticket can be traced back.",
        },
      },
      required: ["draft_id", "action"],
    },
  },
  {
    name: "explain_answer",
    description:
      "Show how a previous ask_about_account answer was built: which excerpts retrieval picked and how strongly each scored, which provider and model answered, how long each step took, and optionally the literal prompt that was sent. Use it when an answer looks wrong or surprising — the cause is usually retrieval picking the wrong evidence, which the answer text alone never shows. Costs nothing; reads stored rows.",
    inputSchema: {
      type: "object",
      properties: {
        trace_id: {
          type: "string",
          description: "The trace id printed under an ask_about_account answer. Omit it and pass account instead to get that account's most recent answer.",
        },
        account: {
          type: "string",
          description: "Account name — returns the most recent answer for it. Ignored when trace_id is given.",
        },
        include_prompt: {
          type: "boolean",
          description: "Include the exact prompt sent to the model. Long; useful when the retrieved excerpts look right but the answer doesn't.",
        },
      },
    },
  },
];

function textResult(text: string, isError = false): ToolContent {
  return { content: [{ type: "text", text }], isError };
}

export async function callTool(env: Env, name: string, args: Record<string, unknown>): Promise<ToolContent> {
  switch (name) {
    case "list_accounts": {
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const accounts = await allDbAccounts(env.DB);
      const matches = query ? accounts.filter((a) => a.name.toLowerCase().includes(query)) : accounts;
      if (!matches.length) {
        return textResult(query ? `No accounts match "${args.query as string}".` : "No accounts found.");
      }
      return textResult(matches.map((a) => `${a.name} — renews ${a.renewal_date}, owner ${a.csm_owner_name ?? "unassigned"}`).join("\n"));
    }

    case "get_account_health": {
      const accountQuery = typeof args.account === "string" ? args.account.trim() : "";
      if (!accountQuery) return textResult("account is required.", true);

      const resolution = await resolveHealth(env, accountQuery);
      switch (resolution.kind) {
        case "account_not_found":
          return textResult(
            `No account matching "${resolution.query}". Some accounts I do know: ${resolution.sampleNames.join(", ")}.`,
            true
          );
        case "health_error":
          return textResult(`Couldn't compute health for ${resolution.account.name} right now — the usage provider may be unreachable.`, true);
        case "health": {
          const h = resolution.health;
          const tierLabel = h.tier === "at_risk" ? "at risk" : h.tier;
          const delta = h.baselineDeltaPct >= 0 ? `+${h.baselineDeltaPct}` : `${h.baselineDeltaPct}`;
          const headline = `${resolution.account.name}: ${tierLabel}. ${h.avgActiveSeats} of ${h.seatsPurchased} seats active (${delta}% vs its own baseline), renews in ${h.renewalDaysOut} days. Owner: ${resolution.account.csm_owner_name ?? "unassigned"}.`;
          // The tier is usage only. Handing back the last few things on file
          // alongside it is what stops an agent reporting "healthy" on the
          // morning of an angry ticket.
          const lately = recentLines(resolution.recent, (label, url) => `${label} — ${url}`)
            .map((line) => `- ${line}`)
            .join("\n");
          return textResult(
            lately
              ? `${headline}\n\nLately (most recent first, independent of the tier):\n${lately}`
              : `${headline}\n\nNothing ingested for this account yet, so the tier is the only signal here.`
          );
        }
        default:
          return textResult("Unexpected error resolving account health.", true);
      }
    }

    case "ask_about_account": {
      const accountQuery = typeof args.account === "string" ? args.account.trim() : "";
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!accountQuery || !question) return textResult("account and question are both required.", true);

      const account = await findAccountByName(env.DB, accountQuery);
      if (!account) return textResult(`No account matching "${accountQuery}".`, true);

      const resolution = await resolveQuestion(env, account, question);
      switch (resolution.kind) {
        case "question_error":
          return textResult(`Couldn't retrieve an answer for ${account.name} right now.`, true);
        case "question": {
          // Numbered to match the [n] markers in the answer, with the record's
          // own words and a URL the agent — or the person reading over its
          // shoulder — can open.
          const sources = citationLines(buildCitations(resolution.chunks), (label, url) => `${label} — ${url}`).join("\n\n");
          const unverified = unverifiedQuotes(resolution.answer, resolution.chunks);
          const warning = unverified.length
            ? `\n\n⚠️ Not found verbatim in the notes: ${unverified.map((q) => `“${q}”`).join("; ")}. Treat as the model's wording, not the customer's.`
            : "";
          const trace = resolution.traceId
            ? `\n\nTrace ${resolution.traceId} — call explain_answer with this id to see which excerpts were retrieved, how they scored, and which model answered.`
            : "";
          return textResult(`${resolution.answer}${warning}${sources ? `\n\nSources:\n${sources}` : ""}${trace}`);
        }
        default:
          return textResult("Unexpected error answering the question.", true);
      }
    }

    case "get_account_context": {
      const accountQuery = typeof args.account === "string" ? args.account.trim() : "";
      const topic = typeof args.topic === "string" ? args.topic.trim() : "";
      if (!accountQuery || !topic) return textResult("account and topic are both required.", true);

      const account = await findAccountByName(env.DB, accountQuery);
      if (!account) return textResult(`No account matching "${accountQuery}".`, true);

      const requested = typeof args.limit === "number" ? args.limit : 5;
      const limit = Math.max(1, Math.min(20, Math.floor(requested)));

      let chunks;
      try {
        chunks = await retrieveContext(env, account.account_id, topic, limit);
      } catch (err) {
        console.error("retrieveContext failed", err);
        return textResult(`Couldn't search ${account.name}'s history right now.`, true);
      }

      if (!chunks.length) {
        return textResult(
          `Nothing ingested for ${account.name} matches "${topic}" — either no context has been connected for this account yet, or nothing on file is relevant.`
        );
      }

      const excerpts = chunks
        .map(
          (c, i) =>
            `[${i + 1}] ${c.source}${c.occurredAt ? ` · ${c.occurredAt}` : ""} (relevance ${c.score.toFixed(2)})` +
            `${c.url ? `\n    ${c.url}` : ""}\n${c.chunkText}`
        )
        .join("\n\n");
      return textResult(`${chunks.length} excerpt(s) from ${account.name}'s history, most relevant first:\n\n${excerpts}`);
    }

    case "get_account_timeline": {
      const accountQuery = typeof args.account === "string" ? args.account.trim() : "";
      if (!accountQuery) return textResult("account is required.", true);

      const account = await findAccountByName(env.DB, accountQuery);
      if (!account) return textResult(`No account matching "${accountQuery}".`, true);

      const requested = typeof args.limit === "number" ? args.limit : 25;
      const limit = Math.max(1, Math.min(100, Math.floor(requested)));

      const timeline = await buildTimeline(env, account.account_id, limit);
      if (!timeline) return textResult(`No account matching "${accountQuery}".`, true);

      return textResult(renderTimelineText(timeline, { limit }));
    }

    case "draft_engineering_ticket": {
      const accountQuery = typeof args.account === "string" ? args.account.trim() : "";
      const topic = typeof args.topic === "string" ? args.topic.trim() : "";
      if (!accountQuery || !topic) return textResult("account and topic are both required.", true);

      const account = await findAccountByName(env.DB, accountQuery);
      if (!account) return textResult(`No account matching "${accountQuery}".`, true);

      let chunks;
      try {
        chunks = await retrieveContext(env, account.account_id, topic, 5);
      } catch (err) {
        console.error("retrieveContext failed", err);
        return textResult(`Couldn't search ${account.name}'s history right now.`, true);
      }

      const summary =
        typeof args.summary === "string" && args.summary.trim()
          ? args.summary.trim()
          : `Raised from ${account.name}'s account context: ${topic}.`;

      const draft = buildTicketDraft({
        accountName: account.name,
        topic,
        summary,
        chunks,
        facts: [
          `${account.plan} plan`,
          `${account.seats_purchased} seats`,
          `renews ${account.renewal_date}`,
          `owner ${account.csm_owner_name ?? "unassigned"}`,
        ],
      });
      const body = renderTicketMarkdown(draft);

      const draftId = await saveDraft(env, {
        accountId: account.account_id,
        title: draft.title,
        body,
        evidence: draft.evidence,
        origin: "mcp",
      });

      const provider = resolveProvider(await trackerConfig(env));
      const where = provider
        ? `It would be filed in ${provider} once approved.`
        : "No tracker is configured, so this can be read but not filed — set LINEAR_API_KEY + LINEAR_TEAM_ID, or the four JIRA_* settings.";
      const thin = draft.evidence.length
        ? ""
        : " Nothing matching that topic is on file, so this draft carries no customer quotes — filing it would tell engineering very little.";

      return textResult(
        `Saved as draft ${draftId}. Nothing has been sent to any tracker.\n\nTitle: ${draft.title}\n\n${body}\n\n${where}${thin}\n\nShow this to the person who owns the account. If they approve it, call file_ticket_draft with draft_id ${draftId}, action "file" and their name.`
      );
    }

    case "list_ticket_drafts": {
      const status = args.status === "filed" || args.status === "discarded" ? args.status : "pending";
      const accountQuery = typeof args.account === "string" ? args.account.trim() : "";

      let accountId: string | undefined;
      if (accountQuery) {
        const account = await findAccountByName(env.DB, accountQuery);
        if (!account) return textResult(`No account matching "${accountQuery}".`, true);
        accountId = account.account_id;
      }

      const limit = typeof args.limit === "number" ? args.limit : 20;
      const drafts = await listDrafts(env, { status, accountId, limit });
      if (!drafts.length) {
        return textResult(status === "pending" ? "No drafts are waiting for review." : `No ${status} drafts.`);
      }

      const lines = drafts.map((d) => {
        const filed = d.trackerKey ? ` → ${d.trackerKey} ${d.trackerUrl ?? ""}` : "";
        return `${d.id}\n  ${d.accountName ?? d.accountId} · ${d.createdAt} · via ${d.origin} · ${d.status}${filed}\n  ${d.title}`;
      });
      return textResult(`${drafts.length} ${status} draft(s), newest first:\n\n${lines.join("\n\n")}`);
    }

    case "file_ticket_draft": {
      const draftId = typeof args.draft_id === "string" ? args.draft_id.trim() : "";
      const action = typeof args.action === "string" ? args.action.trim() : "";
      if (!draftId) return textResult("draft_id is required.", true);

      const draft = await getDraft(env, draftId);
      if (!draft) return textResult(`No draft ${draftId}.`, true);
      if (draft.status !== "pending") {
        const where = draft.trackerUrl ? ` (${draft.trackerKey}: ${draft.trackerUrl})` : "";
        return textResult(`Draft ${draftId} was already ${draft.status}${where}. Nothing done.`, true);
      }

      if (action === "discard") {
        await discardDraft(env, draftId);
        return textResult(`Draft ${draftId} discarded. Nothing was filed.`);
      }
      if (action !== "file") return textResult(`Unknown action "${action}". Use "file" or "discard".`, true);

      const approvedBy = typeof args.approved_by === "string" ? args.approved_by.trim() : "";
      if (!approvedBy) {
        return textResult(
          "Not filed: approved_by is required, and must be the person who actually approved it. Show them the draft first.",
          true
        );
      }

      try {
        // The stored text is filed verbatim — what was reviewed is what
        // lands, with no regeneration in between that could change it.
        const created = await createTicket(env, {
          title: draft.title,
          accountName: draft.accountName ?? draft.accountId,
          summary: `${draft.body}\n\nApproved by ${approvedBy}.`,
          evidence: [],
          facts: [],
        });
        const claimed = await markFiled(env, draftId, { tracker: created.provider, key: created.key, url: created.url });
        return textResult(
          claimed
            ? `Filed ${created.key} in ${created.provider}: ${created.url}`
            : `Filed ${created.key} (${created.url}), but the draft had already been decided by someone else — check for a duplicate.`
        );
      } catch (err) {
        console.error("file_ticket_draft failed", err);
        return textResult(`Couldn't file it: ${err instanceof Error ? err.message : String(err)}. The draft is still pending.`, true);
      }
    }

    case "explain_answer": {
      const traceId = typeof args.trace_id === "string" ? args.trace_id.trim() : "";
      const accountQuery = typeof args.account === "string" ? args.account.trim() : "";
      const includePrompt = args.include_prompt === true;

      if (!traceId && !accountQuery) return textResult("Pass either trace_id or account.", true);

      let trace;
      if (traceId) {
        trace = await getAnswerTrace(env, traceId);
        if (!trace) {
          return textResult(
            `No trace ${traceId}. Traces expire on a retention window (30 days by default), so an older answer may no longer have one.`,
            true
          );
        }
      } else {
        const account = await findAccountByName(env.DB, accountQuery);
        if (!account) return textResult(`No account matching "${accountQuery}".`, true);
        trace = await latestAnswerTrace(env, account.account_id);
        if (!trace) return textResult(`No questions have been answered about ${account.name} yet.`);
      }

      return textResult(renderTrace(trace, { includePrompt }));
    }

    default:
      return textResult(`Unknown tool: ${name}`, true);
  }
}

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonRpcError(id: string | number | null, code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Handles one JSON-RPC request over the MCP Streamable HTTP transport.
 * Caller (src/index.ts) is responsible for authenticating the request first
 * — this function assumes it's already allowed to run. */
export async function handleMcpRequest(req: Request, env: Env): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = await req.json();
  } catch {
    return jsonRpcError(null, -32700, "Parse error", 400);
  }

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonRpcError(body.id ?? null, -32600, "Invalid Request", 400);
  }

  const id = body.id ?? null;

  switch (body.method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      // Notifications carry no id and expect no JSON-RPC response body —
      // 202 with an empty body is the accepted convention over HTTP.
      return new Response(null, { status: 202 });

    case "tools/list":
      return jsonRpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const params = body.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const name = params?.name;
      if (!name) return jsonRpcError(id, -32602, "Invalid params: name is required");
      const result = await callTool(env, name, params?.arguments ?? {});
      return jsonRpcResult(id, result);
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${body.method}`);
  }
}
