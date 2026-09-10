import "dotenv/config";
import pkg from "@slack/bolt";
const { App } = pkg;

import { getConfig } from "./config.js";
import { pool, findAccountByName, allDbAccounts, getAccountById, setOwnerSlackId, recordHealthSnapshot, getLatestSnapshot } from "./db.js";
import { computeHealth } from "./baseline.js";
import { buildAccountBlocks } from "./card.js";

let config;
try {
  config = getConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const app = new App({
  token: config.slack.botToken,
  signingSecret: config.slack.signingSecret,
  appToken: config.slack.appToken,
  socketMode: true,
});

/** Strip the leading @Bell mention off an app_mention event's text. */
function stripMention(text: string): string {
  return text.replace(/^<@[^>]+>\s*/, "").trim();
}

/** Very loose extraction: "how is X doing", "how's X", or just "X". */
function extractAccountQuery(text: string): string {
  const m = text.match(/how(?:'s| is)\s+(.+?)\s+doing\??$/i);
  if (m) return m[1];
  return text.replace(/[?.!]+$/, "").trim();
}

app.event("app_mention", async ({ event, say }) => {
  const text = stripMention((event as any).text ?? "");
  const query = extractAccountQuery(text);

  if (!query) {
    await say("Ask me things like `@Bell how is Northwind doing?`");
    return;
  }

  const account = await findAccountByName(query);
  if (!account) {
    const sample = (await allDbAccounts())
      .slice(0, 5)
      .map((a) => a.name)
      .join(", ");
    await say(`I don't have an account matching "${query}". A few I do know: ${sample}.`);
    return;
  }

  let health;
  try {
    health = await computeHealth(account);
  } catch (err) {
    console.error("computeHealth failed", err);
    await say(`Couldn't pull usage data for ${account.name} right now — try again in a moment.`);
    return;
  }

  await recordHealthSnapshot(account.account_id, health.avgActiveSeats, health.baselineDeltaPct, health.tier);

  await say({
    text: `${account.name} health summary`,
    blocks: buildAccountBlocks(account, health),
  });
});

app.action("view_account", async ({ ack, body, respond }) => {
  await ack();
  const accountId = (body as any).actions[0].value as string;
  const account = await getAccountById(accountId);
  if (!account) {
    await respond(`Couldn't find that account anymore.`);
    return;
  }

  const latest = await getLatestSnapshot(accountId);
  const lines = [
    `*${account.name}* — full detail`,
    `Plan: ${account.plan} · Seats purchased: ${account.seats_purchased}`,
    `Renewal: ${account.renewal_date}`,
    latest
      ? `Last checked: ${new Date(latest.checked_at).toLocaleString()} — ${latest.tier} (${latest.baseline_delta_pct > 0 ? "+" : ""}${latest.baseline_delta_pct}% vs baseline)`
      : `No health history recorded yet.`,
  ];
  await respond(lines.join("\n"));
});

app.action("assign_owner", async ({ ack, body, client }) => {
  await ack();
  const actionBody = body as any;
  const accountId = actionBody.actions[0].value as string;
  const channelId = actionBody.channel?.id;
  const messageTs = actionBody.message?.ts;

  await client.views.open({
    trigger_id: actionBody.trigger_id,
    view: {
      type: "modal",
      callback_id: "assign_owner_modal",
      private_metadata: JSON.stringify({ accountId, channelId, messageTs }),
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
});

app.view("assign_owner_modal", async ({ ack, view, client }) => {
  await ack();
  const { accountId, channelId, messageTs } = JSON.parse(view.private_metadata) as {
    accountId: string;
    channelId?: string;
    messageTs?: string;
  };
  const selectedUserId = (view.state.values as any).owner_block.owner_select.selected_user as string;

  await setOwnerSlackId(accountId, selectedUserId);
  const account = await getAccountById(accountId);

  if (channelId) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: `Assigned ${account?.name ?? accountId} to <@${selectedUserId}> — they've been notified.`,
    });
  }
});

app.start(config.port).then(() => {
  console.log(`⚡️ Bellwether Slack app is running (socket mode, port ${config.port} for health checks)`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down…`);
  await app.stop();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
