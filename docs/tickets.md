# Filing engineering tickets

Bellwether reads everywhere else. This is the one place it writes into
someone else's system, so it is built to be unable to surprise you:

**Nothing ever reaches Linear or Jira without a person approving it by name.**

That isn't a policy, it's the shape of the code. Every path that can propose
a ticket — a coding agent, a scheduled sweep, a Slack button — can only write
to Bellwether's own `ticket_drafts` table. One tool files, it takes a draft
id that already exists, and it refuses without an approver's name.

## The flow

1. **Draft.** `draft_engineering_ticket` retrieves what the customer actually
   said about a topic and saves a draft: a title, a body carrying their
   verbatim words, and a link to each record. Nothing leaves Bellwether.
2. **Review.** `list_ticket_drafts` shows what's waiting. Read the body — it
   is exactly what will be filed.
3. **Decide.** `file_ticket_draft` with `action: "file"` and `approved_by`,
   or `action: "discard"`.

A filed ticket records who approved it, so an unexplained item in a backlog
can be traced back to a person rather than to "the bot".

## Why the ticket is worth reading

An engineer opening it sees the customer's own words and can click through to
the ticket or transcript they came from:

```markdown
Raised from Northwind's account context: SSO certificate expiry.

**Northwind:** pro plan · 40 seats · renews 2026-11-05 · owner Maya

### What the customer actually said

> SSO certificate expired — new users cannot log in at all.

— [zendesk · 2026-09-06](https://northwind.zendesk.com/agent/tickets/4412)
```

The first question about any relayed bug report is "is this real, or
third-hand?" This answers it before it's asked.

## Connecting a tracker

Either one. With both configured, `TRACKER_PROVIDER` decides.

**Linear** — Settings → Security & access → Personal API keys:

```bash
npx wrangler secret put LINEAR_API_KEY    # goes in Authorization raw, no "Bearer"
npx wrangler secret put LINEAR_TEAM_ID    # the team the issue belongs to
```

**Jira Cloud** — an API token from id.atlassian.com → Security:

```bash
npx wrangler secret put JIRA_SITE_URL     # https://yourcompany.atlassian.net
npx wrangler secret put JIRA_EMAIL        # the Atlassian account the token belongs to
npx wrangler secret put JIRA_API_TOKEN
npx wrangler secret put JIRA_PROJECT_KEY  # e.g. ENG
# optional: JIRA_ISSUE_TYPE, defaults to "Task"
```

Without a tracker, drafting still works — you just can't file. That's a
reasonable way to use it: the draft is most of the value.

## What hasn't been proven yet

**Neither provider has been run against a live workspace.** Both are written
from published API documentation, and this is a write rather than a read, so
the failure mode is a malformed issue rather than an empty result. File the
first one into a throwaway project.

Two details worth knowing, because they are the usual way these break:

- Linear wants the personal API key in `Authorization` **raw**, with no
  `Bearer` prefix, unlike nearly everything else here.
- Jira Cloud v3 requires `description` in **Atlassian Document Format** — a
  nested JSON document. A plain string is rejected. That's why a draft is
  structured data rather than a markdown blob: Linear gets markdown, Jira
  gets ADF, both rendered from the same source.

## Still to come

The proactive half. A scheduled sweep can already write a draft with
`origin: "scheduled"` — leaving a proposal waiting for review rather than
filing it — but nothing schedules one yet, and there is no approve button in
Slack or on the timeline. Both are the next step, and neither changes the
rule above: a human approves, by name, or it doesn't get filed.
