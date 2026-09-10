import { getPostHogConfig } from "./config.js";

interface HogQLResponse {
  results: unknown[][];
  columns?: string[];
}

async function runHogQL(query: string, values?: Record<string, string>): Promise<HogQLResponse> {
  const { host, projectId, apiKey } = getPostHogConfig();
  const resp = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query, values } }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`PostHog query failed: HTTP ${resp.status} — ${body.slice(0, 500)}`);
  }

  return resp.json() as Promise<HogQLResponse>;
}

export interface DailyActivePoint {
  day: string; // ISO date
  activeSeats: number;
}

/**
 * Daily distinct active users (by person) for one account, over the full
 * ingested history. Deliberately daily, not calendar-week-bucketed: a
 * trailing calendar week is a partial bucket relative to "now" and
 * undercounts every account, not just declining ones. Rolling windows
 * measured in days-from-now (done in baseline.ts) avoid that bias.
 */
export async function getDailyActiveSeats(accountId: string): Promise<DailyActivePoint[]> {
  const query = `
    SELECT
      toDate(timestamp) AS day,
      count(DISTINCT person_id) AS active_seats
    FROM events
    WHERE event = 'app_opened'
      AND properties.$group_0 = {accountId}
    GROUP BY day
    ORDER BY day ASC
  `;

  const { results } = await runHogQL(query, { accountId });
  return results.map((row) => ({
    day: String(row[0]),
    activeSeats: Number(row[1]),
  }));
}
