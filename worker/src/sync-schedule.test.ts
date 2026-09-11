import { describe, expect, it } from "vitest";
import { isSyncDue } from "./sync-schedule.js";

const NOW = new Date("2026-09-10T12:00:00Z");

describe("isSyncDue", () => {
  it("is always due when there's no prior sync", () => {
    expect(isSyncDue(undefined, 24, NOW)).toBe(true);
  });

  it("is not due when less time has passed than the chosen frequency", () => {
    const lastSyncAt = new Date(NOW.getTime() - 3 * 60 * 60 * 1000); // 3h ago
    expect(isSyncDue(lastSyncAt, 4, NOW)).toBe(false);
  });

  it("is due once at least the chosen frequency has elapsed", () => {
    const lastSyncAt = new Date(NOW.getTime() - 4 * 60 * 60 * 1000); // exactly 4h ago
    expect(isSyncDue(lastSyncAt, 4, NOW)).toBe(true);
  });

  it("is due when well past the chosen frequency", () => {
    const lastSyncAt = new Date(NOW.getTime() - 30 * 60 * 60 * 1000); // 30h ago
    expect(isSyncDue(lastSyncAt, 24, NOW)).toBe(true);
  });
});
