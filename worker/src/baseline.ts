import type { Env } from "./env.js";
import type { DbAccount } from "./db.js";
import { getDailyActiveSeats, type DailyActivePoint } from "./posthog.js";

export interface HealthSnapshot {
  avgActiveSeats: number; // avg distinct daily active users over the current window
  seatsPurchased: number;
  baselineDeltaPct: number; // negative = down vs baseline
  tier: "stable" | "watch" | "at_risk";
  renewalDaysOut: number;
}

// Tuned empirically against the 60-account seeded ground truth (see
// data-seed/accounts.json). A 10-day current window cleanly separates
// "at_risk" (cliff pattern) from everything else with zero overlap; the
// watch/stable boundary has some inherent overlap on small (6-20 user)
// accounts, which matches real-world small-account anomaly detection
// limits.
const CURRENT_WINDOW_DAYS = 10;
const BASELINE_WINDOW_DAYS = 49;
const AT_RISK_THRESHOLD_PCT = -40;
const WATCH_THRESHOLD_PCT = -20;

function avgInWindow(points: DailyActivePoint[], startOffsetDays: number, endOffsetDays: number, now: Date): number {
  const end = new Date(now);
  end.setDate(end.getDate() - startOffsetDays);
  const start = new Date(now);
  start.setDate(start.getDate() - endOffsetDays);

  const vals = points
    .filter((p) => {
      const d = new Date(p.day);
      return d > start && d <= end;
    })
    .map((p) => p.activeSeats);

  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export async function computeHealth(env: Env, account: DbAccount, now: Date = new Date()): Promise<HealthSnapshot> {
  const points = await getDailyActiveSeats(env, account.account_id);

  const current = avgInWindow(points, 0, CURRENT_WINDOW_DAYS, now);
  const baseline = avgInWindow(points, CURRENT_WINDOW_DAYS, CURRENT_WINDOW_DAYS + BASELINE_WINDOW_DAYS, now);
  const deltaPct = baseline > 0 ? ((current - baseline) / baseline) * 100 : 0;

  let tier: HealthSnapshot["tier"] = "stable";
  if (deltaPct <= AT_RISK_THRESHOLD_PCT) tier = "at_risk";
  else if (deltaPct <= WATCH_THRESHOLD_PCT) tier = "watch";

  const renewalDaysOut = Math.round(
    (new Date(account.renewal_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );

  return {
    avgActiveSeats: Math.round(current),
    seatsPurchased: account.seats_purchased,
    baselineDeltaPct: Math.round(deltaPct),
    tier,
    renewalDaysOut,
  };
}
