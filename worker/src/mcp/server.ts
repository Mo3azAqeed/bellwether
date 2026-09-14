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
          return textResult(
            `${resolution.account.name}: ${tierLabel}. ${h.avgActiveSeats} of ${h.seatsPurchased} seats active (${delta}% vs its own baseline), renews in ${h.renewalDaysOut} days. Owner: ${resolution.account.csm_owner_name ?? "unassigned"}.`
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
          // The URL is the point of a citation inside a coding agent: the
          // agent can open it, and so can the person reading over its shoulder.
          const sources = resolution.chunks
            .map(
              (c, i) =>
                `[${i + 1}] ${c.source}${c.occurredAt ? ` · ${c.occurredAt}` : ""}${c.url ? `\n    ${c.url}` : ""}`
            )
            .join("\n");
          return textResult(`${resolution.answer}${sources ? `\n\nSources:\n${sources}` : ""}`);
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
