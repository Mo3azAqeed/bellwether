import type { Env } from "./env.js";
import type { DbAccount } from "./db.js";
import type { HealthSnapshot } from "./baseline.js";
import { getSetting } from "./settings.js";
import { postMessage } from "./slack/api.js";
import { buildAlertBlocks } from "./slack/blocks.js";

/** Posts a proactive alert to SLACK_ALERTS_CHANNEL when an account's health
 * tier changes, called from the nightly sweep (src/index.ts) with the tier
 * from *before* this run's snapshot was recorded. No-ops quietly if
 * alerting isn't configured, if this is the account's first-ever snapshot
 * (nothing to compare against), or if the tier didn't actually change —
 * so a run that alerts on nothing is normal, not a failure. */
export async function maybeAlert(
  env: Env,
  account: DbAccount,
  previousTier: HealthSnapshot["tier"] | undefined,
  health: HealthSnapshot
): Promise<void> {
  if (!previousTier || previousTier === health.tier) return;

  const channel = await getSetting(env, "SLACK_ALERTS_CHANNEL");
  if (!channel) return;

  await postMessage(env.SLACK_BOT_TOKEN, {
    channel,
    text: `${account.name}'s health tier changed: ${previousTier} → ${health.tier}`,
    blocks: buildAlertBlocks(account, previousTier, health),
  });
}
