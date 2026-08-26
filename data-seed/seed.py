#!/usr/bin/env python3
"""
Generate a synthetic 90-day B2B SaaS usage history for ~60 accounts and
ingest it into PostHog via the batch capture API. See schema.md.

Usage:
  python3 seed.py --dry-run     # generate + report counts, no network calls
  python3 seed.py               # actually ingest into PostHog
"""
import argparse
import json
import random
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

PROJECT_API_KEY = "phc_pPfoXTj22sHTqvQh6XJbGZ0c1SgRsTWW5FMAEtE0kdu"
CAPTURE_HOST = "https://eu.i.posthog.com"  # EU Cloud project
BATCH_ENDPOINT = f"{CAPTURE_HOST}/batch/"
BATCH_SIZE = 500

TODAY = datetime(2026, 8, 26, tzinfo=timezone.utc)
DAYS_OF_HISTORY = 90
START_DATE = TODAY - timedelta(days=DAYS_OF_HISTORY)

random.seed(42)

NAME_PREFIXES = [
    "Cedar", "Brook", "North", "Silver", "Vertex", "Anchor", "Delta",
    "Crescent", "Harbor", "Ember", "Quartz", "Willow", "Granite", "Cobalt",
    "Fathom", "Nimbus", "Solace", "Ridge", "Meridian", "Foxglove", "Marrow",
    "Onyx", "Tandem", "Lantern", "Pinecrest", "Ironwood", "Windmere",
    "Copperline", "Amberfield", "Bluepeak", "Rosewood", "Slate", "Hollow",
    "Fernway", "Gladstone", "Ashgrove", "Wrenfield", "Palisade", "Thornbury",
    "Kestrel", "Driftwood", "Larkspur", "Mosswell", "Brightside", "Halcyon",
    "Vale", "Redshift", "Clearwater", "Stonebridge", "Timbermill", "Loomis",
    "Cinderfield", "Wintercrest", "Sable", "Hearthstone", "Longview",
    "Basalt", "Windrow", "Cascade", "Ferngate", "Underline",
]
NAME_SUFFIXES = [
    "Labs", "Systems", "Analytics", "Works", "Digital", "Cloud", "Group",
    "Networks", "Partners", "Solutions", "Technologies", "Dynamics",
    "Software", "Ventures", "Industries",
]
INDUSTRIES = [
    "Fintech", "Healthtech", "E-commerce", "Logistics", "Marketing",
    "HR Tech", "EdTech", "Real Estate", "Legal Tech", "DevTools",
]
CSM_OWNERS = ["Maya", "Jordan", "Priya", "Sam", "Alex"]
FEATURES = [
    "dashboard", "reports", "search", "settings", "export",
    "automation_builder", "integration_hub", "api_playground",
]
PLAN_SEAT_RANGE = {"Starter": (6, 10), "Growth": (10, 16), "Enterprise": (14, 20)}
ACTIVITY_TIERS = {
    # tier: (weekday_prob, weekend_prob)
    "daily": (0.85, 0.35),
    "regular": (0.5, 0.15),
    "occasional": (0.22, 0.05),
    "dormant": (0.05, 0.01),
}
ACTIVITY_WEIGHTS = {"daily": 0.15, "regular": 0.45, "occasional": 0.30, "dormant": 0.10}


def make_company_names(n):
    names = set()
    combos = [(p, s) for p in NAME_PREFIXES for s in NAME_SUFFIXES]
    random.shuffle(combos)
    for p, s in combos:
        names.add(f"{p} {s}")
        if len(names) >= n:
            break
    return list(names)[:n]


def weighted_choice(weights: dict):
    keys = list(weights.keys())
    vals = list(weights.values())
    return random.choices(keys, weights=vals, k=1)[0]


def slugify(name):
    return name.lower().replace(" ", "")


def build_accounts():
    n_accounts = 60
    names = make_company_names(n_accounts)

    # ground-truth usage pattern assignment
    patterns = ["cliff"] * 5 + ["slow_fade"] * 8 + ["stable"] * (n_accounts - 13)
    random.shuffle(patterns)

    # force the two continuity accounts from the landing page mock
    if "Northwind" not in names:
        names[0] = "Northwind"
    names[names.index("Northwind")], names[0] = names[0], names[names.index("Northwind")]
    if "Lumen Labs" not in names:
        names[1] = "Lumen Labs"
    names[names.index("Lumen Labs")], names[1] = names[1], names[names.index("Lumen Labs")]
    patterns[0] = "cliff"       # Northwind: hard cliff, "at risk"
    patterns[1] = "slow_fade"   # Lumen Labs: gradual, "watch"

    accounts = []
    for i, name in enumerate(names):
        account_id = f"acct-{i+1:03d}"
        plan = random.choice(["Starter", "Growth", "Enterprise"])
        lo, hi = PLAN_SEAT_RANGE[plan]
        user_count = random.randint(max(6, lo), min(20, hi))
        seats_purchased = user_count + random.randint(0, 3)
        signup_days_ago = random.randint(90, 900)
        signup_date = TODAY - timedelta(days=signup_days_ago)
        renewal_date = TODAY + timedelta(days=random.randint(10, 365))
        seat_rate = {"Starter": 900, "Growth": 1400, "Enterprise": 2200}[plan]
        arr = seats_purchased * seat_rate

        users = []
        for u in range(user_count):
            tier = weighted_choice(ACTIVITY_WEIGHTS)
            if u == 0:
                tier = random.choice(["daily", "regular"])  # admin tends to be engaged
            users.append({
                "distinct_id": f"{account_id}-user-{u+1:02d}",
                "name": f"User {u+1:02d}",
                "email": f"user{u+1:02d}@{slugify(name)}.io",
                "role": "Admin" if u == 0 else random.choice(["Member", "Member", "Viewer"]),
                "tier": tier,
            })

        accounts.append({
            "account_id": account_id,
            "name": name,
            "industry": random.choice(INDUSTRIES),
            "plan": plan,
            "seats_purchased": seats_purchased,
            "signup_date": signup_date.date().isoformat(),
            "renewal_date": renewal_date.date().isoformat(),
            "csm_owner": random.choice(CSM_OWNERS),
            "arr": arr,
            "usage_pattern": patterns[i],
            "users": users,
        })
    return accounts


def decline_multiplier(pattern, day_index):
    """day_index: 0 .. DAYS_OF_HISTORY-1, 0 = oldest day, last = today."""
    days_from_end = DAYS_OF_HISTORY - 1 - day_index
    if pattern == "cliff":
        cliff_start = 21
        if days_from_end >= cliff_start:
            return 1.0
        floor = 0.25
        progress = (cliff_start - days_from_end) / cliff_start
        return max(floor, 1.0 - progress * (1.0 - floor))
    if pattern == "slow_fade":
        fade_start = 45
        if days_from_end >= fade_start:
            return 1.0
        floor = 0.5
        progress = (fade_start - days_from_end) / fade_start
        return max(floor, 1.0 - progress * (1.0 - floor))
    return 1.0  # stable, with per-day noise applied by caller


def business_hour_timestamp(day: datetime):
    hour = random.choices(
        population=list(range(7, 20)),
        weights=[1, 2, 4, 6, 7, 8, 6, 5, 7, 8, 6, 4, 2],
        k=1,
    )[0]
    minute = random.randint(0, 59)
    second = random.randint(0, 59)
    return day.replace(hour=hour, minute=minute, second=second, microsecond=0)


def generate_events(accounts):
    events = []

    for acc in accounts:
        acc_id = acc["account_id"]
        pattern = acc["usage_pattern"]

        # $groupidentify once
        events.append({
            "event": "$groupidentify",
            "distinct_id": f"{acc_id}-groupidentify",
            "properties": {
                "$group_type": "account",
                "$group_key": acc_id,
                "$group_set": {
                    "name": acc["name"],
                    "industry": acc["industry"],
                    "plan": acc["plan"],
                    "seats_purchased": acc["seats_purchased"],
                    "signup_date": acc["signup_date"],
                    "renewal_date": acc["renewal_date"],
                    "csm_owner": acc["csm_owner"],
                    "arr": acc["arr"],
                    "usage_pattern": acc["usage_pattern"],
                },
            },
            "timestamp": START_DATE.isoformat(),
        })

        for user in acc["users"]:
            wd_prob, we_prob = ACTIVITY_TIERS[user["tier"]]

            # $identify once
            events.append({
                "event": "$identify",
                "distinct_id": user["distinct_id"],
                "properties": {
                    "$set": {
                        "email": user["email"],
                        "name": user["name"],
                        "role": user["role"],
                        "account_id": acc_id,
                    }
                },
                "timestamp": START_DATE.isoformat(),
            })

            for day_index in range(DAYS_OF_HISTORY):
                day = START_DATE + timedelta(days=day_index)
                is_weekend = day.weekday() >= 5
                base_prob = we_prob if is_weekend else wd_prob

                mult = decline_multiplier(pattern, day_index)
                if pattern == "stable":
                    mult *= random.uniform(0.85, 1.1)

                prob = min(0.98, base_prob * mult)
                if random.random() > prob:
                    continue  # not active this day

                ts = business_hour_timestamp(day)
                groups = {"account": acc_id}

                events.append({
                    "event": "app_opened",
                    "distinct_id": user["distinct_id"],
                    "properties": {"$groups": groups},
                    "timestamp": ts.isoformat(),
                })

                for _ in range(random.randint(0, 3)):
                    feature_ts = ts + timedelta(minutes=random.randint(1, 45))
                    events.append({
                        "event": "feature_used",
                        "distinct_id": user["distinct_id"],
                        "properties": {
                            "$groups": groups,
                            "feature_name": random.choice(FEATURES),
                        },
                        "timestamp": feature_ts.isoformat(),
                    })
    return events


def send_batches(events, batch_size=BATCH_SIZE, start_index=0, progress_path=None):
    """start_index: skip events before this index (for resuming after a failure).
    progress_path: if set, the index of the next unsent event is written here
    after every successful batch, so a crash can be resumed exactly."""
    total = len(events)
    sent = start_index
    for i in range(start_index, total, batch_size):
        chunk = events[i:i + batch_size]
        payload = {"api_key": PROJECT_API_KEY, "batch": chunk}

        for attempt in range(4):
            try:
                resp = requests.post(BATCH_ENDPOINT, json=payload, timeout=60)
                if resp.status_code == 200:
                    break
                print(f"  batch at {i}: HTTP {resp.status_code} — {resp.text[:300]}", file=sys.stderr)
            except requests.exceptions.RequestException as e:
                print(f"  batch at {i}: {e!r} (attempt {attempt+1}/4)", file=sys.stderr)
            if attempt == 3:
                if progress_path:
                    with open(progress_path, "w") as f:
                        f.write(str(i))
                raise RuntimeError(f"Failed to send batch at index {i} after 4 attempts. Resume with --start-index {i}.")
            time.sleep(2 ** attempt)

        sent += len(chunk)
        if progress_path:
            with open(progress_path, "w") as f:
                f.write(str(i + len(chunk)))
        print(f"  ingested {sent}/{total} events", flush=True)
        time.sleep(0.05)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    accounts = build_accounts()
    events = generate_events(accounts)

    ground_truth = [
        {k: a[k] for k in ("account_id", "name", "plan", "seats_purchased",
                            "usage_pattern", "csm_owner", "renewal_date")}
        for a in accounts
    ]
    out_path = "/home/moaz/bellwether/data-seed/accounts.json"
    with open(out_path, "w") as f:
        json.dump(ground_truth, f, indent=2)

    total_users = sum(len(a["users"]) for a in accounts)
    pattern_counts = {}
    for a in accounts:
        pattern_counts[a["usage_pattern"]] = pattern_counts.get(a["usage_pattern"], 0) + 1

    print(f"Accounts: {len(accounts)}  Users: {total_users}  Events: {len(events)}")
    print(f"Date range: {START_DATE.date()} .. {TODAY.date()}")
    print(f"Usage patterns: {pattern_counts}")
    print(f"Ground truth written to {out_path}")

    if args.dry_run:
        print("\n--dry-run: skipping ingestion.")
        sample = [e for e in events if e["event"] not in ("$groupidentify", "$identify")][:3]
        print("Sample events:")
        for e in sample:
            print(" ", json.dumps(e))
        return

    print(f"\nIngesting into {CAPTURE_HOST} ...")
    send_batches(events)
    print("Done.")


if __name__ == "__main__":
    main()
