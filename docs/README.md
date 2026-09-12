# Bellwether documentation

Start at [Deploy](deploy.md) if you're setting this up for the first time.
Everything here assumes you're running it in your own infrastructure,
because that's the only way it runs.

| | |
|---|---|
| **[Deploy](deploy.md)** | From an empty Cloudflare account to `@Bell` answering in Slack or Teams |
| **[Connect your tools](setup.md)** | The setup wizard and the CLI — where credentials actually get entered |
| **[Context sources](connectors.md)** | Call transcripts, tickets and CRM notes: the eight built-in connectors, the generic ingest endpoint, and how fresh each one is |
| **[Use it from your coding agent](mcp.md)** | MCP for Claude Code, Cursor, Codex and OpenCode — and who pays for which model call |
| **[The context layer as files](context-files.md)** | Pull everything down as markdown you can read, grep and diff |
| **[Configuration reference](configuration.md)** | Every variable, where it can be set, whether it's required |
| **[Architecture](architecture.md)** | What each piece does, and where it lives in the repo |
| **[Local development](development.md)** | Running it on your machine, and the conventions to follow when changing it |

Deploying with a coding agent instead of by hand? [`AGENTS.md`](../AGENTS.md)
is written for the agent, not for you — point Claude Code, Cursor or Codex at
this repo and ask it to set Bellwether up, and it will follow that file.

Something here wrong, stale, or missing?
[Open an issue](https://github.com/Mo3azAqeed/bellwether/issues) — docs bugs
count as bugs.
