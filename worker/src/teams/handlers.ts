/** Routes incoming Bot Framework Activities for Teams. Mirrors
 * slack/handlers.ts in shape, but the two protocols differ enough
 * (Activities vs. Events API, Adaptive Cards vs. Block Kit, no modals) that
 * this isn't a thin wrapper — the actual answering logic (bot-logic.ts) is
 * what's shared, not the plumbing.
 *
 * NOTE: Adaptive Card Action.Submit has been delivered as a plain `message`
 * activity with `.value` populated for years — that's what this handles.
 * Newer Teams clients may instead send it as an `invoke` activity
 * (`adaptiveCard/action`, the "Universal Actions" model), which has its own
 * synchronous response contract this doesn't fully implement (a best-effort
 * branch below just acks it) — verify against
 * https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/Universal-actions-for-adaptive-cards/work-with-universal-actions-for-adaptive-cards
 * if button clicks don't come through in practice. */

import type { Env } from "../env.js";
import { getAccountById, setOwnerName, getLatestSnapshot } from "../db.js";
import { resolveMention, resolveQuestion, type MentionResolution } from "../bot-logic.js";
import { buildAccountCard, buildAnswerCard, buildAssignOwnerCard } from "./cards.js";
import { replyToActivity } from "./api.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface TeamsActivity {
  type: string;
  name?: string;
  text?: string;
  value?: Record<string, unknown>;
  entities?: { type: string; text?: string; mentioned?: { id: string; name?: string } }[];
  conversation: { id: string };
  serviceUrl: string;
  id?: string;
  recipient?: { id: string };
  from?: { id: string; name?: string };
}

export function stripMentionEntities(activity: TeamsActivity): string {
  let text = activity.text ?? "";
  for (const entity of activity.entities ?? []) {
    if (entity.type === "mention" && entity.text && entity.mentioned?.id === activity.recipient?.id) {
      text = text.replace(entity.text, " ");
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

async function sendResolution(env: Env, activity: TeamsActivity, resolution: MentionResolution) {
  switch (resolution.kind) {
    case "empty":
      await replyToActivity(env, activity, { text: "Ask me things like \"how is Northwind doing?\" or \"why is Northwind declining?\"" });
      return;
    case "account_not_found":
      await replyToActivity(env, activity, {
        text: `I don't have an account matching "${resolution.query}". A few I do know: ${resolution.sampleNames.join(", ")}.`,
      });
      return;
    case "health":
      await replyToActivity(env, activity, {
        text: `${resolution.account.name} health summary`,
        attachments: [buildAccountCard(resolution.account, resolution.health, resolution.recent)],
      });
      return;
    case "health_error":
      await replyToActivity(env, activity, { text: `Couldn't pull usage data for ${resolution.account.name} right now — try again in a moment.` });
      return;
    case "question":
      await replyToActivity(env, activity, {
        text: `${resolution.account.name}: ${resolution.answer}`,
        attachments: [buildAnswerCard(resolution.account.name, resolution.answer, resolution.chunks)],
      });
      return;
    case "question_error":
      await replyToActivity(env, activity, { text: `Couldn't pull an answer for ${resolution.account.name} right now — try again in a moment.` });
      return;
    case "unresolved_question":
      await replyToActivity(env, activity, { text: 'Which account? Name it, like "why is Northwind declining?"' });
      return;
  }
}

export function extractActionValue(activity: TeamsActivity): Record<string, unknown> | undefined {
  if (activity.type === "message" && activity.value) return activity.value;
  if (activity.type === "invoke" && activity.name === "adaptiveCard/action") {
    const value = activity.value as { action?: { data?: Record<string, unknown> }; data?: Record<string, unknown> } | undefined;
    return value?.action?.data ?? value?.data;
  }
  return undefined;
}

async function handleCardAction(env: Env, activity: TeamsActivity, actionValue: Record<string, unknown>) {
  const action = actionValue.action as string | undefined;
  const accountId = actionValue.accountId as string | undefined;
  if (!accountId) return;

  if (action === "view_account") {
    const account = await getAccountById(env.DB, accountId);
    if (!account) {
      await replyToActivity(env, activity, { text: "Couldn't find that account anymore." });
      return;
    }
    const latest = await getLatestSnapshot(env.DB, accountId);
    const lines = [
      `**${account.name}** — full detail`,
      `Plan: ${account.plan} · Seats purchased: ${account.seats_purchased}`,
      `Renewal: ${account.renewal_date}`,
      latest
        ? `Last checked: ${new Date(latest.checked_at).toLocaleString()} — ${latest.tier} (${latest.baseline_delta_pct > 0 ? "+" : ""}${latest.baseline_delta_pct}% vs baseline)`
        : "No health history recorded yet.",
    ];
    await replyToActivity(env, activity, { text: lines.join("\n\n") });
    return;
  }

  if (action === "assign_owner_prompt") {
    await replyToActivity(env, activity, { text: "Assign owner", attachments: [buildAssignOwnerCard(accountId)] });
    return;
  }

  if (action === "assign_owner_submit") {
    const ownerName = (actionValue.ownerName as string | undefined)?.trim();
    if (!ownerName) {
      await replyToActivity(env, activity, { text: "Enter a name before submitting." });
      return;
    }
    await setOwnerName(env.DB, accountId, ownerName);
    const account = await getAccountById(env.DB, accountId);
    await replyToActivity(env, activity, { text: `Assigned ${account?.name ?? accountId} to ${ownerName}.` });
    return;
  }

  if (action === "explain_account") {
    const account = await getAccountById(env.DB, accountId);
    if (!account) {
      await replyToActivity(env, activity, { text: "Couldn't find that account anymore." });
      return;
    }
    const resolution = await resolveQuestion(env, account, "What's happening with this account's usage and why?");
    if (resolution.kind === "question") {
      await replyToActivity(env, activity, {
        text: `${account.name}: ${resolution.answer}`,
        attachments: [buildAnswerCard(account.name, resolution.answer, resolution.chunks)],
      });
    } else {
      await replyToActivity(env, activity, { text: `Couldn't pull an answer for ${account.name} right now — try again in a moment.` });
    }
  }
}

export async function handleTeamsActivity(env: Env, activity: TeamsActivity): Promise<void> {
  const actionValue = extractActionValue(activity);
  if (actionValue) {
    await handleCardAction(env, activity, actionValue);
    return;
  }

  if (activity.type !== "message") return; // conversationUpdate, typing, etc. — nothing to answer

  const text = stripMentionEntities(activity);
  const resolution = await resolveMention(env, text);
  await sendResolution(env, activity, resolution);
}
