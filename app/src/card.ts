import type { DbAccount } from "./db.js";
import type { HealthSnapshot } from "./baseline.js";

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
    return `Not great. Usage has been pulling away and it's down *${Math.abs(h.baselineDeltaPct)}%* against its own baseline.`;
  }
  if (h.tier === "watch") {
    return `Slowing down. Down *${Math.abs(h.baselineDeltaPct)}%* against its own baseline over the last few weeks.`;
  }
  return `Looking healthy — tracking close to its usual baseline.`;
}

export function buildAccountBlocks(account: DbAccount, health: HealthSnapshot) {
  const renewalText =
    health.renewalDaysOut >= 0
      ? `in ${health.renewalDaysOut} days`
      : `${Math.abs(health.renewalDaysOut)} days ago`;

  const ownerText = account.csm_owner_slack_id
    ? `<@${account.csm_owner_slack_id}>`
    : account.csm_owner_name ?? "Unassigned";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${TIER_EMOJI[health.tier]} *${account.name}*\n${summaryLine(health)}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Active seats (10-day avg)*\n${health.avgActiveSeats} of ${health.seatsPurchased}` },
        { type: "mrkdwn", text: `*Against baseline*\n${health.baselineDeltaPct > 0 ? "+" : ""}${health.baselineDeltaPct}%` },
        { type: "mrkdwn", text: `*Renewal*\n${renewalText}` },
        { type: "mrkdwn", text: `*Owner*\n${ownerText}` },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View account" },
          action_id: "view_account",
          value: account.account_id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Assign owner" },
          action_id: "assign_owner",
          value: account.account_id,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Status: ${TIER_LABEL[health.tier]} · computed from PostHog usage data`,
        },
      ],
    },
  ];
}
