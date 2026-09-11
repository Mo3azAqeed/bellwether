import type { Env } from "../env.js";
import { getAccountById, setOwnerSlackId, getLatestSnapshot } from "../db.js";
import { resolveMention, resolveQuestion, type MentionResolution } from "../bot-logic.js";
import { buildAccountBlocks, buildAnswerBlocks } from "./blocks.js";
import { postMessage, openView, respondToInteraction } from "./api.js";

function stripMention(text: string): string {
  return text.replace(/^<@[^>]+>\s*/, "").trim();
}

async function sendResolution(env: Env, channel: string, threadTs: string | undefined, resolution: MentionResolution) {
  switch (resolution.kind) {
    case "empty":
      await postMessage(env.SLACK_BOT_TOKEN, {
        channel,
        thread_ts: threadTs,
        text: "Ask me things like `@Bell how is Northwind doing?` or `@Bell why is Northwind declining?`",
      });
      return;
    case "account_not_found":
      await postMessage(env.SLACK_BOT_TOKEN, {
        channel,
        thread_ts: threadTs,
        text: `I don't have an account matching "${resolution.query}". A few I do know: ${resolution.sampleNames.join(", ")}.`,
      });
      return;
    case "health":
      await postMessage(env.SLACK_BOT_TOKEN, {
        channel,
        thread_ts: threadTs,
        text: `${resolution.account.name} health summary`,
        blocks: buildAccountBlocks(resolution.account, resolution.health),
      });
      return;
    case "health_error":
      await postMessage(env.SLACK_BOT_TOKEN, {
        channel,
        thread_ts: threadTs,
        text: `Couldn't pull usage data for ${resolution.account.name} right now — try again in a moment.`,
      });
      return;
    case "question":
      await postMessage(env.SLACK_BOT_TOKEN, {
        channel,
        thread_ts: threadTs,
        text: `${resolution.account.name}: ${resolution.answer}`,
        blocks: buildAnswerBlocks(resolution.account.name, resolution.answer, resolution.chunks),
      });
      return;
    case "question_error":
      await postMessage(env.SLACK_BOT_TOKEN, {
        channel,
        thread_ts: threadTs,
        text: `Couldn't pull an answer for ${resolution.account.name} right now — try again in a moment.`,
      });
      return;
    case "unresolved_question":
      await postMessage(env.SLACK_BOT_TOKEN, {
        channel,
        thread_ts: threadTs,
        text: "Which account? Mention its name, like `@Bell why is Northwind declining?`",
      });
      return;
  }
}

export async function handleAppMention(env: Env, event: { text?: string; channel: string; ts: string }) {
  const text = stripMention(event.text ?? "");
  const resolution = await resolveMention(env, text);
  await sendResolution(env, event.channel, event.ts, resolution);
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
    const resolution = await resolveQuestion(env, account, "What's happening with this account's usage and why?");
    if (resolution.kind === "question") {
      await respondToInteraction(responseUrl, {
        text: `${account.name}: ${resolution.answer}`,
        blocks: buildAnswerBlocks(account.name, resolution.answer, resolution.chunks),
        replace_original: false,
      });
    } else {
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
