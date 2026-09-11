import type { Env } from "../env.js";
import {
  findAccountByName,
  allDbAccounts,
  getAccountById,
  setOwnerSlackId,
  recordHealthSnapshot,
  getLatestSnapshot,
  type DbAccount,
} from "../db.js";
import { computeHealth } from "../baseline.js";
import { buildAccountBlocks, buildAnswerBlocks } from "./blocks.js";
import { postMessage, openView, respondToInteraction } from "./api.js";
import { retrieveContext } from "../rag/retrieve.js";
import { generateAnswer } from "../rag/generate.js";

function stripMention(text: string): string {
  return text.replace(/^<@[^>]+>\s*/, "").trim();
}

type ParsedQuery =
  | { kind: "health"; accountQuery: string }
  | { kind: "question"; accountName: string; question: string }
  | { kind: "unresolved_question"; question: string }
  | { kind: "empty" };

async function parseQuery(db: Env["DB"], text: string): Promise<ParsedQuery> {
  if (!text) return { kind: "empty" };

  const howMatch = text.match(/how(?:'s| is)\s+(.+?)\s+doing\??$/i);
  if (howMatch) return { kind: "health", accountQuery: howMatch[1] };

  const looksLikeQuestion = /\?\s*$/.test(text) || /^(why|what|when|who|which|tell me|how come)\b/i.test(text);
  if (looksLikeQuestion) {
    const accounts = await allDbAccounts(db);
    const lower = text.toLowerCase();
    // Longest matching name wins, so "Northwind Labs" beats a coincidental
    // shorter match if both happened to appear.
    let best: DbAccount | undefined;
    for (const a of accounts) {
      if (lower.includes(a.name.toLowerCase())) {
        if (!best || a.name.length > best.name.length) best = a;
      }
    }
    return best
      ? { kind: "question", accountName: best.name, question: text }
      : { kind: "unresolved_question", question: text };
  }

  return { kind: "health", accountQuery: text.replace(/[?.!]+$/, "").trim() };
}

async function handleHealthQuery(env: Env, channel: string, threadTs: string | undefined, accountQuery: string) {
  if (!accountQuery) {
    await postMessage(env.SLACK_BOT_TOKEN, {
      channel,
      thread_ts: threadTs,
      text: "Ask me things like `@Bell how is Northwind doing?` or `@Bell why is Northwind declining?`",
    });
    return;
  }

  const account = await findAccountByName(env.DB, accountQuery);
  if (!account) {
    const sample = (await allDbAccounts(env.DB)).slice(0, 5).map((a) => a.name).join(", ");
    await postMessage(env.SLACK_BOT_TOKEN, {
      channel,
      thread_ts: threadTs,
      text: `I don't have an account matching "${accountQuery}". A few I do know: ${sample}.`,
    });
    return;
  }

  let health;
  try {
    health = await computeHealth(env, account);
  } catch (err) {
    console.error("computeHealth failed", err);
    await postMessage(env.SLACK_BOT_TOKEN, {
      channel,
      thread_ts: threadTs,
      text: `Couldn't pull usage data for ${account.name} right now — try again in a moment.`,
    });
    return;
  }

  await recordHealthSnapshot(env.DB, account.account_id, health.avgActiveSeats, health.baselineDeltaPct, health.tier);

  await postMessage(env.SLACK_BOT_TOKEN, {
    channel,
    thread_ts: threadTs,
    text: `${account.name} health summary`,
    blocks: buildAccountBlocks(account, health),
  });
}

async function handleQuestion(env: Env, channel: string, threadTs: string | undefined, account: DbAccount, question: string) {
  let chunks, answer;
  try {
    chunks = await retrieveContext(env, account.account_id, question);
    answer = await generateAnswer(env, account.name, question, chunks);
  } catch (err) {
    console.error("retrieveContext/generateAnswer failed", err);
    await postMessage(env.SLACK_BOT_TOKEN, {
      channel,
      thread_ts: threadTs,
      text: `Couldn't pull an answer for ${account.name} right now — try again in a moment.`,
    });
    return;
  }

  await postMessage(env.SLACK_BOT_TOKEN, {
    channel,
    thread_ts: threadTs,
    text: `${account.name}: ${answer}`,
    blocks: buildAnswerBlocks(account.name, answer, chunks),
  });
}

export async function handleAppMention(env: Env, event: { text?: string; channel: string; ts: string }) {
  const text = stripMention(event.text ?? "");
  const parsed = await parseQuery(env.DB, text);

  switch (parsed.kind) {
    case "empty":
      await handleHealthQuery(env, event.channel, event.ts, "");
      return;
    case "health":
      await handleHealthQuery(env, event.channel, event.ts, parsed.accountQuery);
      return;
    case "question": {
      const account = await findAccountByName(env.DB, parsed.accountName);
      if (!account) return; // resolved from the account list, so this shouldn't happen
      await handleQuestion(env, event.channel, event.ts, account, parsed.question);
      return;
    }
    case "unresolved_question":
      await postMessage(env.SLACK_BOT_TOKEN, {
        channel: event.channel,
        thread_ts: event.ts,
        text: "Which account? Mention its name, like `@Bell why is Northwind declining?`",
      });
      return;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleBlockAction(env: Env, payload: any) {
  const action = payload.actions[0];
  const accountId = action.value as string;
  const responseUrl = payload.response_url as string;

  if (action.action_id === "view_account") {
    const account = await getAccountById(env.DB, accountId);
    if (!account) {
      await respondToInteraction(responseUrl, { text: "Couldn't find that account anymore.", replace_original: false });
      return;
    }
    const latest = await getLatestSnapshot(env.DB, accountId);
    const lines = [
      `*${account.name}* — full detail`,
      `Plan: ${account.plan} · Seats purchased: ${account.seats_purchased}`,
      `Renewal: ${account.renewal_date}`,
      latest
        ? `Last checked: ${new Date(latest.checked_at).toLocaleString()} — ${latest.tier} (${latest.baseline_delta_pct > 0 ? "+" : ""}${latest.baseline_delta_pct}% vs baseline)`
        : `No health history recorded yet.`,
    ];
    await respondToInteraction(responseUrl, { text: lines.join("\n"), replace_original: false });
    return;
  }

  if (action.action_id === "assign_owner") {
    await openView(env.SLACK_BOT_TOKEN, {
      trigger_id: payload.trigger_id,
      view: {
        type: "modal",
        callback_id: "assign_owner_modal",
        private_metadata: JSON.stringify({
          accountId,
          channelId: payload.channel?.id,
          messageTs: payload.message?.ts,
        }),
        title: { type: "plain_text", text: "Assign owner" },
        submit: { type: "plain_text", text: "Assign" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "owner_block",
            label: { type: "plain_text", text: "New owner" },
            element: {
              type: "users_select",
              action_id: "owner_select",
              placeholder: { type: "plain_text", text: "Pick a teammate" },
            },
          },
        ],
      },
    });
    return;
  }

  if (action.action_id === "explain_account") {
    const account = await getAccountById(env.DB, accountId);
    if (!account) {
      await respondToInteraction(responseUrl, { text: "Couldn't find that account anymore.", replace_original: false });
      return;
    }
    const question = "What's happening with this account's usage and why?";
    try {
      const chunks = await retrieveContext(env, accountId, question);
      const answer = await generateAnswer(env, account.name, question, chunks);
      await respondToInteraction(responseUrl, {
        text: `${account.name}: ${answer}`,
        blocks: buildAnswerBlocks(account.name, answer, chunks),
        replace_original: false,
      });
    } catch (err) {
      console.error("retrieveContext/generateAnswer failed", err);
      await respondToInteraction(responseUrl, {
        text: `Couldn't pull an answer for ${account.name} right now — try again in a moment.`,
        replace_original: false,
      });
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleViewSubmission(env: Env, payload: any) {
  const { accountId, channelId, messageTs } = JSON.parse(payload.view.private_metadata) as {
    accountId: string;
    channelId?: string;
    messageTs?: string;
  };
  const selectedUserId = payload.view.state.values.owner_block.owner_select.selected_user as string;

  await setOwnerSlackId(env.DB, accountId, selectedUserId);
  const account = await getAccountById(env.DB, accountId);

  if (channelId) {
    await postMessage(env.SLACK_BOT_TOKEN, {
      channel: channelId,
      thread_ts: messageTs,
      text: `Assigned ${account?.name ?? accountId} to <@${selectedUserId}> — they've been notified.`,
    });
  }
}
