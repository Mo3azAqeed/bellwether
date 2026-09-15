import type { DbAccount } from "../db.js";
import type { HealthSnapshot } from "../baseline.js";
import type { RetrievedChunk } from "../rag/retrieve.js";
import { recentLines, type RecentDocument } from "../rag/recent.js";
import type { AdaptiveCardAttachment } from "./api.js";

const TIER_LABEL: Record<HealthSnapshot["tier"], string> = {
  stable: "Stable",
  watch: "Watch",
  at_risk: "At risk",
};

const TIER_EMOJI: Record<HealthSnapshot["tier"], string> = {
  stable: "🟢",
  watch: "🟡",
  at_risk: "🔴",
};

function summaryLine(h: HealthSnapshot): string {
  if (h.tier === "at_risk") {
    return `Not great. Usage has been pulling away and it's down **${Math.abs(h.baselineDeltaPct)}%** against its own baseline.`;
  }
  if (h.tier === "watch") {
    return `Slowing down. Down **${Math.abs(h.baselineDeltaPct)}%** against its own baseline over the last few weeks.`;
  }
  return "Looking healthy — tracking close to its usual baseline.";
}

function wrapCard(body: unknown[]): AdaptiveCardAttachment {
  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body,
    },
  };
}

export function buildAccountCard(
  account: DbAccount,
  health: HealthSnapshot,
  recent: RecentDocument[] = []
): AdaptiveCardAttachment {
  const renewalText = health.renewalDaysOut >= 0 ? `in ${health.renewalDaysOut} days` : `${Math.abs(health.renewalDaysOut)} days ago`;
  // No Teams equivalent of Slack's <@user> mention rendering from a stored
  // Slack user id — csm_owner_slack_id is a Slack-specific field, so Teams
  // always shows the plain seed-data name here (see "Assign owner" below
  // for how a real assignment gets recorded from this side instead).
  const ownerText = account.csm_owner_name ?? "Unassigned";

  return wrapCard([
    { type: "TextBlock", text: `${TIER_EMOJI[health.tier]} **${account.name}**`, wrap: true, size: "Medium", weight: "Bolder" },
    { type: "TextBlock", text: summaryLine(health), wrap: true },
    {
      type: "FactSet",
      facts: [
        { title: "Active seats (10-day avg)", value: `${health.avgActiveSeats} of ${health.seatsPurchased}` },
        { title: "Against baseline", value: `${health.baselineDeltaPct > 0 ? "+" : ""}${health.baselineDeltaPct}%` },
        { title: "Renewal", value: renewalText },
        { title: "Owner", value: ownerText },
      ],
    },
    // Usage says the account is fine; the last ticket may say otherwise.
    ...(recent.length
      ? [
          {
            type: "TextBlock",
            text: `**Lately**\n\n${recentLines(recent, (label, url) => `[${label}](${url})`)
              .map((line) => `• ${line}`)
              .join("\n\n")}`,
            wrap: true,
          },
        ]
      : []),
    {
      type: "ActionSet",
      actions: [
        { type: "Action.Submit", title: "View account", data: { action: "view_account", accountId: account.account_id } },
        { type: "Action.Submit", title: "Assign owner", data: { action: "assign_owner_prompt", accountId: account.account_id } },
        { type: "Action.Submit", title: "Why?", data: { action: "explain_account", accountId: account.account_id } },
      ],
    },
    {
      type: "TextBlock",
      text: `Status: ${TIER_LABEL[health.tier]} · tier computed from usage data${recent.length ? ", with what was said lately alongside it" : ""}`,
      wrap: true,
      isSubtle: true,
      size: "Small",
    },
  ]);
}

const TIER_RANK: Record<HealthSnapshot["tier"], number> = { stable: 0, watch: 1, at_risk: 2 };

export function buildAlertCard(account: DbAccount, previousTier: HealthSnapshot["tier"], health: HealthSnapshot): AdaptiveCardAttachment {
  const direction = TIER_RANK[health.tier] > TIER_RANK[previousTier] ? "dropped" : "improved";
  const icon = direction === "dropped" ? "⚠️" : "✅";
  const header = {
    type: "TextBlock",
    text: `${icon} **${account.name}**'s health tier just ${direction} — ${TIER_LABEL[previousTier]} → ${TIER_LABEL[health.tier]}`,
    wrap: true,
    weight: "Bolder",
  };
  const accountCard = buildAccountCard(account, health).content as { body: unknown[] };
  return wrapCard([header, ...accountCard.body]);
}

export function buildAnswerCard(accountName: string, answer: string, sources: RetrievedChunk[]): AdaptiveCardAttachment {
  const body: unknown[] = [{ type: "TextBlock", text: `**${accountName}**`, wrap: true, weight: "Bolder" }, { type: "TextBlock", text: answer, wrap: true }];

  if (sources.length > 0) {
    const sourceText = sources
      .map((s) => {
        const label = `${s.source}${s.occurredAt ? ` · ${s.occurredAt}` : ""}`;
        // Adaptive Card TextBlocks render a markdown link; fall back to
        // plain emphasis rather than pointing anywhere uncertain.
        const head = s.url ? `[${label}](${s.url})` : `*${label}*`;
        return `• ${head}: ${s.chunkText.slice(0, 140)}${s.chunkText.length > 140 ? "…" : ""}`;
      })
      .join("\n\n");
    body.push({ type: "TextBlock", text: `Sources:\n\n${sourceText}`, wrap: true, isSubtle: true, size: "Small" });
  } else {
    body.push({ type: "TextBlock", text: "No ingested notes for this account yet — this is usage data only.", wrap: true, isSubtle: true, size: "Small" });
  }

  return wrapCard(body);
}

/** Teams has no Slack-style "pick a teammate" user picker without a Graph
 * API lookup this bot doesn't do — so assignment is a plain text field for
 * the owner's display name rather than a real user reference. Simpler,
 * less structured than the Slack version; documented as a known gap. */
export function buildAssignOwnerCard(accountId: string): AdaptiveCardAttachment {
  return wrapCard([
    { type: "TextBlock", text: "Assign owner", weight: "Bolder" },
    {
      type: "Input.Text",
      id: "ownerName",
      label: "New owner's name",
      placeholder: "e.g. Maya",
    },
    {
      type: "ActionSet",
      actions: [{ type: "Action.Submit", title: "Assign", data: { action: "assign_owner_submit", accountId } }],
    },
  ]);
}
