import type { Env } from "./env.js";
import { getSetting, setSetting } from "./settings.js";

export const VALID_FREQUENCIES_HOURS = [4, 8, 12, 24] as const;
export type SyncFrequencyHours = (typeof VALID_FREQUENCIES_HOURS)[number];
const DEFAULT_FREQUENCY_HOURS: SyncFrequencyHours = 24;

/** The Cron Trigger itself fires every 4 hours (the finest option offered —
 * see wrangler.jsonc); this decides whether a given firing should actually
 * do the work, based on how long it's been since the last one that did.
 * Pure function — no D1/Date.now() inside — so it's unit-testable without
 * mocking a clock. */
export function isSyncDue(lastSyncAt: Date | undefined, frequencyHours: number, now: Date): boolean {
  if (!lastSyncAt) return true;
  const elapsedHours = (now.getTime() - lastSyncAt.getTime()) / (1000 * 60 * 60);
  return elapsedHours >= frequencyHours;
}

export async function getSyncFrequencyHours(env: Env): Promise<SyncFrequencyHours> {
  const raw = await getSetting(env, "SYNC_FREQUENCY_HOURS");
  const parsed = Number(raw);
  return (VALID_FREQUENCIES_HOURS as readonly number[]).includes(parsed) ? (parsed as SyncFrequencyHours) : DEFAULT_FREQUENCY_HOURS;
}

async function getLastSyncAt(env: Env): Promise<Date | undefined> {
  const raw = await getSetting(env, "LAST_SYNC_AT");
  return raw ? new Date(raw) : undefined;
}

async function setLastSyncAt(env: Env, when: Date): Promise<void> {
  await setSetting(env, "LAST_SYNC_AT", when.toISOString());
}

/** Call at the top of the scheduled handler. Returns true and records
 * "now" as the new last-sync time if a full sync should run this firing;
 * false if it's not due yet (caller should skip the sweep/backfills). */
export async function claimSyncIfDue(env: Env, now: Date = new Date()): Promise<boolean> {
  const [frequencyHours, lastSyncAt] = await Promise.all([getSyncFrequencyHours(env), getLastSyncAt(env)]);
  if (!isSyncDue(lastSyncAt, frequencyHours, now)) return false;
  await setLastSyncAt(env, now);
  return true;
}
