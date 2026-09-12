# Local development

Running Bellwether on your own machine, and the conventions to follow when changing it.

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # fill in Slack/PostHog values
npm run db:migrate:local
npm run dev                       # wrangler dev, local D1 + simulated bindings
npm test                          # unit tests (health tiers, chunking, VTT parsing)
npm run typecheck
```

Slack needs a public HTTPS URL to send events to, so point its request URLs
(step 6 of [Deploy](deploy.md)) at a tunnel (`wrangler dev --remote`, or `cloudflared tunnel`)
when testing against a real workspace locally.

## Tests

```bash
cd worker
npm test          # vitest — health tiers, chunking, VTT parsing, MCP framing, CRM identity, context rendering
npm run typecheck
npm run typecheck:scripts
```

There's no CI here yet, so those three are the check. Run them before
opening a pull request.

## Conventions

A few rules the codebase holds to. [`AGENTS.md`](../AGENTS.md) has the full
list; these are the ones that bite first:

- **Every credential read goes through `getSetting`/`getSettings`**
  (`worker/src/settings.ts`), never `env.X` directly. D1 is checked first
  with the Workers secret as fallback — that's what lets the wizard and CLI
  take effect without a redeploy.
- **Slack and Teams share one brain.** New "what does this question mean"
  logic goes in `worker/src/bot-logic.ts`, not duplicated into `src/slack/`
  or `src/teams/`. A front end's own code only handles that platform's
  transport.
- **A new credential means three edits**, not one: the `Env` interface
  (`worker/src/env.ts`), the setup registry (`worker/src/setup/integrations.ts`),
  and the [Configuration reference](configuration.md).
- **Formatting stays pure.** Anything under `worker/scripts/` that renders
  output keeps the rendering in a module under `worker/src/` and the I/O in
  the script — see `src/context/format.ts` vs `scripts/context-pull.ts`.
  That's what makes it testable without a database.

## Adding a connector

The six existing ones in `worker/src/connectors/` are the template, and they
all have the same shape: a `getSetting` guard that no-ops when the
credential isn't configured, a fetch, a dedupe on `source + source_ref`, an
account resolution via `resolveAccountId({ emails, title })`, then
`ingestDocument`. Webhook-driven connectors add a route in
`worker/src/index.ts`; backfill-driven ones add a call in the scheduled
handler, wrapped in its own try/catch so one expired token can't take down
the rest of the run.
