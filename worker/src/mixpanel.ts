import type { Env } from "./env.js";
import type { DailyActivePoint } from "./posthog.js";

/** Alternative usage-data source to PostHog (src/posthog.ts) — same output
 * shape, selected via USAGE_PROVIDER (see src/usage.ts), for teams whose
 * product usage already lives in Mixpanel instead. Uses Mixpanel's JQL API
 * for a custom per-day distinct-user aggregation; unlike PostHog's
 * $group_0 convention there's no standard "account" grouping in Mixpanel,
 * so the event name and the property holding the account id are both
 * configurable (MIXPANEL_ACTIVE_EVENT_NAME / MIXPANEL_ACCOUNT_PROPERTY) —
 * set them to match however your own instrumentation tags events.
 *
 * NOTE: JQL syntax is stable long-standing Mixpanel API, but verify against
 * https://developer.mixpanel.com/reference/jql-overview if this stops
 * returning what's expected — not tested against a live project here. */

// JQL: group events by (day, distinct_id) first to dedupe repeat events from
// the same user on the same day down to one row, then group *that* by day
// and count rows — the standard JQL idiom for "distinct users per day".
const JQL_SCRIPT = `
function main() {
  return Events({
    from_date: params.from_date,
    to_date: params.to_date,
    event_selectors: [{ event: params.eventName }]
  })
  .filter(function(event) {
    return String(event.properties[params.accountProperty]) === params.accountId;
  })
  .groupBy(
    [function(e) { return new Date(e.time * 1000).toISOString().slice(0, 10); }, "distinct_id"],
    mixpanel.reducer.count()
  )
  .groupBy(
    [function(r) { return r.key[0]; }],
    mixpanel.reducer.count()
  );
}
`;

interface JqlRow {
  key: [string]; // [day]
  value: number; // distinct user count that day
}

export async function getDailyActiveSeats(env: Env, accountId: string): Promise<DailyActivePoint[]> {
  if (!env.MIXPANEL_PROJECT_ID || !env.MIXPANEL_SERVICE_ACCOUNT_USERNAME || !env.MIXPANEL_SERVICE_ACCOUNT_SECRET) {
    throw new Error("MIXPANEL_PROJECT_ID, MIXPANEL_SERVICE_ACCOUNT_USERNAME, and MIXPANEL_SERVICE_ACCOUNT_SECRET are required");
  }

  const host = env.MIXPANEL_HOST || "https://mixpanel.com";
  const toDate = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const params = new URLSearchParams({
    project_id: env.MIXPANEL_PROJECT_ID,
    script: JQL_SCRIPT,
    params: JSON.stringify({
      from_date: fromDate,
      to_date: toDate,
      eventName: env.MIXPANEL_ACTIVE_EVENT_NAME || "app_opened",
      accountProperty: env.MIXPANEL_ACCOUNT_PROPERTY || "account_id",
      accountId,
    }),
  });

  const resp = await fetch(`${host}/api/query/jql`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.MIXPANEL_SERVICE_ACCOUNT_USERNAME}:${env.MIXPANEL_SERVICE_ACCOUNT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  if (!resp.ok) {
    throw new Error(`Mixpanel JQL query failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 500)}`);
  }

  const rows = await resp.json<JqlRow[]>();
  return rows.map((r) => ({ day: r.key[0], activeSeats: r.value }));
}
