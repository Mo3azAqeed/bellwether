#!/usr/bin/env python3
"""
Adds a second, high-volume event stream (api_request) on top of the first
ingestion, using the SAME 60 accounts/users (deterministic seed in seed.py
guarantees identical identities, so nothing is duplicated as a new group).

Keeps the running total across both ingestion passes under a hard budget so
we stay clear of PostHog's 1,000,000 events/mo free-tier line.

Usage:
  python3 seed_v2.py --dry-run --scale 1.0     # check projected volume
  python3 seed_v2.py --scale 1.0               # actually ingest
"""
import argparse
import json
import random
import sys

import requests

from seed import (
    PROJECT_API_KEY, CAPTURE_HOST, BATCH_ENDPOINT,
    START_DATE, TODAY, DAYS_OF_HISTORY,
    build_accounts, decline_multiplier, send_batches,
)

random.seed(43)  # different stream than seed.py's human events

ALREADY_SENT = 55_978          # from the first ingestion pass
HARD_BUDGET = 900_000          # user's cap, safely under the 1M free line
SAFETY_MARGIN = 20_000         # leave headroom for rounding/estimation error
NEW_EVENT_BUDGET = HARD_BUDGET - ALREADY_SENT - SAFETY_MARGIN  # ~824,000

API_BASE_RATE = {"Starter": 55, "Growth": 115, "Enterprise": 210}  # events/day at full health
API_ENDPOINTS = [
    "/v1/accounts/sync", "/v1/usage/report", "/v1/webhooks/deliver",
    "/v1/exports/create", "/v1/reports/generate", "/v1/integrations/poll",
]


def generate_api_events(accounts, scale):
    events = []
    for acc in accounts:
        acc_id = acc["account_id"]
        pattern = acc["usage_pattern"]
        base_rate = API_BASE_RATE[acc["plan"]] * scale
        system_distinct_id = f"{acc_id}-system"

        for day_index in range(DAYS_OF_HISTORY):
            day = START_DATE.replace() + __import__("datetime").timedelta(days=day_index)
            mult = decline_multiplier(pattern, day_index)
            if pattern == "stable":
                mult *= random.uniform(0.9, 1.1)

            n = max(0, int(random.gauss(base_rate * mult, base_rate * 0.15)))
            for _ in range(n):
                ts = day.replace(
                    hour=random.randint(0, 23),
                    minute=random.randint(0, 59),
                    second=random.randint(0, 59),
                )
                events.append({
                    "event": "api_request",
                    "distinct_id": system_distinct_id,
                    "properties": {
                        "$groups": {"account": acc_id},
                        "endpoint": random.choice(API_ENDPOINTS),
                    },
                    "timestamp": ts.isoformat(),
                })
    return events


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--start-index", type=int, default=0)
    args = parser.parse_args()

    accounts = build_accounts()
    events = generate_api_events(accounts, args.scale)

    print(f"Projected new events at scale={args.scale}: {len(events)}")
    print(f"Budget for new events: {NEW_EVENT_BUDGET}")
    print(f"Projected running total: {ALREADY_SENT + len(events)} (cap {HARD_BUDGET})")

    if len(events) > NEW_EVENT_BUDGET:
        print("OVER BUDGET — reduce --scale and retry.", file=sys.stderr)
        if not args.dry_run:
            sys.exit(1)

    if args.dry_run:
        print("\n--dry-run: skipping ingestion.")
        for e in events[:3]:
            print(" ", json.dumps(e))
        return

    progress_path = "/home/moaz/bellwether/data-seed/.seed_v2_progress"
    print(f"\nIngesting into {CAPTURE_HOST} (resuming from index {args.start_index}) ...")
    send_batches(events, start_index=args.start_index, progress_path=progress_path)
    print("Done.")
    print(f"New running total (approx): {ALREADY_SENT + len(events)}")


if __name__ == "__main__":
    main()
