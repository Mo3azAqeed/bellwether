import type { Env } from "../env.js";

function extractDomain(email: string): string | undefined {
  return email.split("@")[1]?.toLowerCase();
}

/** Shared by every meeting-transcript connector: match a participant's
 * email domain against account_domains first (reliable, if populated),
 * then fall back to the meeting title containing an account name (works
 * for "Sync w/ Northwind" style titles, nothing fancier). Returns
 * undefined if neither resolves — callers should not guess and ingest
 * under the wrong account. */
export async function resolveAccountId(
  env: Env,
  { emails, title }: { emails: string[]; title: string }
): Promise<string | undefined> {
  const domains = [...new Set(emails.map(extractDomain).filter((d): d is string => !!d))];
  if (domains.length > 0) {
    const placeholders = domains.map((_, i) => `?${i + 1}`).join(", ");
    const row = await env.DB.prepare(`SELECT account_id FROM account_domains WHERE domain IN (${placeholders}) LIMIT 1`)
      .bind(...domains)
      .first<{ account_id: string }>();
    if (row) return row.account_id;
  }

  const { results } = await env.DB.prepare(`SELECT account_id, name FROM accounts`).all<{ account_id: string; name: string }>();
  const lowerTitle = title.toLowerCase();
  const match = results.find((a) => lowerTitle.includes(a.name.toLowerCase()));
  return match?.account_id;
}
