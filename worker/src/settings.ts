import type { Env } from "./env.js";

/** Every credential/config read in this app should go through here instead
 * of `env.X` directly — checks the D1 `settings` table first (what the
 * setup UI writes to), then falls back to the matching Workers secret/var,
 * so `wrangler secret put` and the UI are two paths to the same place. */
export async function getSetting(env: Env, key: string): Promise<string | undefined> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?1`).bind(key).first<{ value: string }>();
  if (row) return row.value;
  const fromEnv = (env as unknown as Record<string, string | undefined>)[key];
  return fromEnv || undefined;
}

export async function getSettings(env: Env, keys: string[]): Promise<Record<string, string | undefined>> {
  const entries = await Promise.all(keys.map(async (k) => [k, await getSetting(env, k)] as const));
  return Object.fromEntries(entries);
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value)
    .run();
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM settings WHERE key = ?1`).bind(key).run();
}

/** Which of the given keys have a value at all (D1 or env) — used by the
 * setup UI to show each integration as connected/not without exposing the
 * actual secret values back to the browser. */
export async function whichAreSet(env: Env, keys: string[]): Promise<Record<string, boolean>> {
  const values = await getSettings(env, keys);
  return Object.fromEntries(keys.map((k) => [k, !!values[k]]));
}
