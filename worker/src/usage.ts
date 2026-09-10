import type { Env } from "./env.js";
import type { DailyActivePoint } from "./posthog.js";
import { getDailyActiveSeats as getFromPostHog } from "./posthog.js";
import { getDailyActiveSeats as getFromMixpanel } from "./mixpanel.js";

/** Picks the usage-data source. Defaults to PostHog (the originally
 * supported provider); set USAGE_PROVIDER=mixpanel to use src/mixpanel.ts
 * instead. One or the other, not both — baseline.ts just wants one
 * consistent daily-active-seats series per account, however you produce it. */
export function getDailyActiveSeats(env: Env, accountId: string): Promise<DailyActivePoint[]> {
  const provider = env.USAGE_PROVIDER || "posthog";
  if (provider === "mixpanel") return getFromMixpanel(env, accountId);
  if (provider === "posthog") return getFromPostHog(env, accountId);
  throw new Error(`Unknown USAGE_PROVIDER "${provider}" — expected "posthog" or "mixpanel".`);
}
