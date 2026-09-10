import { describe, expect, it, vi } from "vitest";
import type { DbAccount } from "./db.js";
import type { DailyActivePoint } from "./posthog.js";

vi.mock("./posthog.js", () => ({
  getDailyActiveSeats: vi.fn(),
}));

const { getDailyActiveSeats } = await import("./posthog.js");
const { computeHealth } = await import("./baseline.js");

const NOW = new Date("2026-09-10T00:00:00Z");

function account(overrides: Partial<DbAccount> = {}): DbAccount {
  return {
    account_id: "acct-001",
    name: "Test Co",
    plan: "Growth",
    seats_purchased: 20,
    renewal_date: "2026-12-01",
    csm_owner_name: "Maya",
    csm_owner_slack_id: null,
    usage_pattern: null,
    ...overrides,
  };
}

/** Builds daily points for the last `days` days ending at NOW, at a flat
 * seat count, except the most recent `dropDays` days drop to `dropSeats`. */
function points(days: number, baseSeats: number, dropDays = 0, dropSeats = 0): DailyActivePoint[] {
  const out: DailyActivePoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(NOW);
    d.setDate(d.getDate() - i);
    const activeSeats = i < dropDays ? dropSeats : baseSeats;
    out.push({ day: d.toISOString().slice(0, 10), activeSeats });
  }
  return out;
}

describe("computeHealth", () => {
  it("tags a flat-usage account as stable", async () => {
    vi.mocked(getDailyActiveSeats).mockResolvedValue(points(60, 15));
    const health = await computeHealth(account(), NOW);
    expect(health.tier).toBe("stable");
    expect(health.baselineDeltaPct).toBe(0);
  });

  it("tags a sharp recent drop as at_risk", async () => {
    vi.mocked(getDailyActiveSeats).mockResolvedValue(points(60, 15, 10, 2));
    const health = await computeHealth(account(), NOW);
    expect(health.tier).toBe("at_risk");
    expect(health.baselineDeltaPct).toBeLessThanOrEqual(-40);
  });

  it("tags a moderate recent drop as watch", async () => {
    vi.mocked(getDailyActiveSeats).mockResolvedValue(points(60, 15, 10, 10));
    const health = await computeHealth(account(), NOW);
    expect(health.tier).toBe("watch");
  });

  it("computes renewal days out from the account's renewal date", async () => {
    vi.mocked(getDailyActiveSeats).mockResolvedValue(points(60, 15));
    const health = await computeHealth(account({ renewal_date: "2026-09-20" }), NOW);
    expect(health.renewalDaysOut).toBe(10);
  });

  it("treats no usage history as zero delta rather than throwing", async () => {
    vi.mocked(getDailyActiveSeats).mockResolvedValue([]);
    const health = await computeHealth(account(), NOW);
    expect(health.avgActiveSeats).toBe(0);
    expect(health.baselineDeltaPct).toBe(0);
    expect(health.tier).toBe("stable");
  });
});
