# Security

## Reporting a vulnerability

Email **moazaqeed123@gmail.com** with "Bellwether security" in the subject.
Please don't open a public issue for anything exploitable.

Include what you found, how to reproduce it, and what an attacker could
reach with it. You'll get a reply; if a fix is warranted you'll be credited
in the commit unless you'd rather not be.

This is a small project without a formal disclosure program or a bounty.
What you get is a real answer from a person, reasonably quickly.

## What the threat model actually is

There is no Bellwether-operated backend. Every deployment runs in its
operator's own Cloudflare account, so a vulnerability here is a
vulnerability in *their* deployment, not in a shared service. There is no
central database to breach and nobody — including whoever wrote this code —
holds anyone else's data.

That makes a few classes of bug the ones worth reporting:

- **Anything that lets an unauthenticated request read account context.**
  The `/setup` routes, the ingest endpoint, the MCP endpoint and the
  timeline API all gate on a token; a path around one of those is the most
  serious thing you can find here.
- **Anything that leaks a stored credential.** Connector tokens live in D1
  and in Worker secrets. They should never appear in a response body, a
  log line, an error message, or the setup UI after being saved.
- **Anything that files, sends, or writes outward without approval.**
  Ticket filing is the only outbound write, and it is supposed to be
  impossible to trigger without a draft id and a named approver. A path
  that reaches Linear or Jira without both is a security bug, not a
  feature request.
- **Prompt injection that changes behavior rather than output.** Ingested
  transcripts and tickets are attacker-influenced text by nature — a
  customer can write anything into a support ticket. Text that makes an
  answer wrong is a quality problem. Text that makes Bellwether *act* —
  file a ticket, reach a different account's context — is a security one.

## If you run it

- `SETUP_ADMIN_TOKEN` is the key to everything else. Set it as a Worker
  secret, never in `wrangler.jsonc`, and it is deliberately not settable
  through the setup UI itself.
- Ingest and MCP are both off until you set `INGEST_API_KEY` and
  `MCP_ACCESS_TOKEN` respectively — an unset token means the route answers
  501, not that it's open. Leave either off if you aren't using it.
- The timeline page skips auth on `localhost` only, and that check reads
  the hostname Cloudflare resolved before the script ran, so it can't be
  spoofed by a header. It is still worth understanding before you deploy.
- `npm run context:pull` writes real customer transcripts to disk. `/context`
  is gitignored for that reason — don't un-ignore it.

## Supported versions

`main` is the supported version. There are no backported fixes to older
commits; the project is young enough that "pull and redeploy" is the
upgrade path.
