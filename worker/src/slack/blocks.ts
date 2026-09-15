import type { DbAccount } from "../db.js";
import type { HealthSnapshot } from "../baseline.js";
import { recentLines, type RecentDocument } from "../rag/recent.js";
import type { RetrievedChunk } from "../rag/retrieve.js";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAccountBlocks(account: DbAccount, health: HealthSnapshot, recent: RecentDocument[] = []): any[] {
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
    // Usage says the account is fine; the last ticket may say otherwise.
    // Both belong on the same card, or the card gets believed too easily.
    ...(recent.length
      ? [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Lately*\n${recentLines(recent, (label, url) => `<${url}|${label}>`)
                .map((line) => `• ${line}`)
                .join("\n")}`,
            },
          },
        ]
      : []),
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
        {
          type: "button",
          text: { type: "plain_text", text: "Why?" },
          action_id: "explain_account",
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

const TIER_RANK: Record<HealthSnapshot["tier"], number> = { stable: 0, watch: 1, at_risk: 2 };

/** Proactive tier-change notification — an account card with a header
 * explaining why it showed up unprompted (nobody asked `@Bell` about it;
 * the nightly sweep noticed the tier moved). Wording says "improved" vs
 * "dropped" rather than always "changed" so a recovery doesn't read as bad
 * news. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAlertBlocks(account: DbAccount, previousTier: HealthSnapshot["tier"], health: HealthSnapshot): any[] {
  const direction = TIER_RANK[health.tier] > TIER_RANK[previousTier] ? "dropped" : "improved";
  const headerText =
    direction === "dropped"
      ? `⚠️ *${account.name}*'s health tier just ${direction} — ${TIER_LABEL[previousTier]} → ${TIER_LABEL[health.tier]}`
      : `✅ *${account.name}*'s health tier just ${direction} — ${TIER_LABEL[previousTier]} → ${TIER_LABEL[health.tier]}`;

  return [{ type: "section", text: { type: "mrkdwn", text: headerText } }, ...buildAccountBlocks(account, health)];
}

/** Renders a grounded answer plus the source chunks it was built from, so
 * the reader can check the citation rather than trust the model blindly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAnswerBlocks(
  accountName: string,
  answer: string,
  sources: RetrievedChunk[],
  traceId?: string
): any[] {
  const blocks: any[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${accountName}*\n${answer}` },
    },
  ];

  if (sources.length > 0) {
    const sourceLines = sources
      .map((s) => {
        // Slack link syntax when we know where the record lives, plain
        // italics when we don't — never a link that goes nowhere.
        const label = `${s.source}${s.occurredAt ? ` · ${s.occurredAt}` : ""}`;
        const head = s.url ? `<${s.url}|${label}>` : `_${label}_`;
        return `• ${head}: ${s.chunkText.slice(0, 140)}${s.chunkText.length > 140 ? "…" : ""}`;
      })
      .join("\n");
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Sources:\n${sourceLines}` }],
    });
  } else {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "No ingested notes for this account yet — this is usage data only." }],
    });
  }

  // Citations say which records were used. This says why those records —
  // the scores retrieval assigned and the model that answered. When a
  // grounded answer is wrong it is almost always the former.
  if (traceId) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "How did it get this?" },
          action_id: "explain_answer",
          value: traceId,
        },
      ],
    });
  }

  return blocks;
}
