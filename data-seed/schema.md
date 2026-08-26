# Bellwether — PostHog event schema (v1 seed)

Scope: product-usage signal only (PostHog). Support tickets (Intercom/Zendesk),
renewal/CRM data (HubSpot), and call notes are separate sources layered in later —
not part of this ingestion.

## Group type: `account`

Every event is tagged with `$groups: {"account": "<account_id>"}`. This is the
canonical account identity the whole product hangs off — the "alias table" target
maps external names (Slack mentions, CRM records) onto this same `account_id`.

Set once per account via `$groupidentify`, `$group_set`:

| property         | example                    | notes |
|---|---|---|
| `name`           | "Cedarline Systems"        | display name |
| `industry`       | "Fintech"                  | one of a fixed list |
| `plan`           | "Growth"                   | Starter / Growth / Enterprise |
| `seats_purchased`| 14                         | >= active user count |
| `signup_date`    | "2024-11-02"                | ISO date |
| `renewal_date`   | "2026-10-13"                | ISO date, relative to today (2026-08-26) |
| `csm_owner`      | "Maya"                     | fixed pool of CSM names |
| `arr`            | 16800                      | derived from plan + seats |
| `usage_pattern`  | "stable" / "slow_fade" / "cliff" | ground-truth label for validating the baseline engine later — not a real product field, strip before it ever reaches a customer-facing view |

## Person identity

`distinct_id` = `<account_id>-user-<n>`. Set once via `$identify`, `$set`:

| property     | example                     |
|---|---|
| `email`      | "user03@cedarlinesys.io"    |
| `name`       | "User 03"                   |
| `role`       | "Admin" / "Member" / "Viewer" |
| `account_id` | "acct-001"                  |

## Behavioral events

Both carry `$groups: {"account": "<account_id>"}` and a historical `timestamp`.

- **`app_opened`** — one per active session per user per day. This is the
  heartbeat event the weekly-active-seats metric (and the baseline/anomaly
  engine) is computed from.
- **`feature_used`** — 0-3 per active day, `properties.feature_name` ∈
  `{dashboard, reports, search, settings, export, automation_builder,
  integration_hub, api_playground}`. Adds texture for later "what changed"
  narratives; not load-bearing for v1 anomaly detection.

## Simulated population

- 60 accounts, 6-20 users each (uniform), users assigned an activity tier
  (`daily` / `regular` / `occasional` / `dormant`) that sets their per-day
  active probability, higher on weekdays.
- 90 days of history ending today.
- `usage_pattern` per account:
  - **stable** (~47 accounts): flat probability, weekly noise only, a few with
    slight organic growth.
  - **slow_fade** (~8 accounts, "Watch" tier): linear decline over the final
    45 days down to ~40-60% of baseline. Includes "Lumen Labs" for continuity
    with the landing page mock.
  - **cliff** (~5 accounts, "At risk" tier): sharp drop starting ~21 days out,
    down to ~20-30% of baseline. Includes "Northwind" for continuity with the
    landing page mock.

Ground truth (`accounts.json`, written alongside the ingestion script) records
which accounts got which pattern, so the baseline engine's output can be
checked against a known answer instead of eyeballing it.
