# The account timeline

`https://<your-worker>/timeline`

One page, one vertical axis: everything known about an account in the order
it happened. A call in August, the ticket that followed, the tier dropping
two weeks later, the answer Bell gave about it on Monday — read top to
bottom, that's the account's recent history. Read as search results, it
isn't anything.

Every entry says where it came from and, wherever the record is linkable,
goes there in one click.

## What's on it

| Entry | What it is |
|---|---|
| **Source records** | A call transcript, support ticket or CRM note, with the source, its id, how many chunks it was split into, and an opening excerpt |
| **Health tier changes** | Only the readings where the tier actually moved — snapshots are written on every sweep and every question, and showing all of them would bury everything a human wrote |
| **Answers Bell gave** | The question, the answer, which provider and model produced it, and the records it was built from — each one a link |

Newest first. A document with no date is left off rather than floated to the
top: there's nowhere honest to put it on a timeline.

## Getting in

It's gated by `SETUP_ADMIN_TOKEN`, the same credential as the setup wizard,
and returns 501 when that isn't set.

**That is a real limitation, not a finished design.** This page shows
verbatim customer conversations, so it wants per-user authentication, and an
admin token shared with whoever configures the deployment is not that. Treat
the URL as sensitive until that changes. If you need it in front of a whole
CS team today, put it behind [Cloudflare
Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
and keep the token as a second factor.

## How it relates to the other two ways in

- **Slack and Teams** answer a question where you're already working.
- **MCP** puts the same context inside your coding agent.
- **The timeline** is for the ten minutes before a renewal call, when the
  question isn't "what's the answer" but "what has actually been happening
  here, and who said it".

`explain_answer` over MCP covers the same provenance for a single answer,
including retrieval scores and the literal prompt — that's the debugging
view. The timeline is the reading view.
