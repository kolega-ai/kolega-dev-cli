<h1 align="center">
  <code>@kolegaai/cli</code>
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@kolegaai/cli">
    <img src="https://img.shields.io/npm/v/%40kolegaai%2Fcli.svg" alt="npm version">
  </a>
</p>

<p align="center">
  <strong>The official CLI for <a href="https://kolega.dev">Kolega DevSec</a></strong><br>
  Find and fix security vulnerabilities before they ship.
</p>

<p align="center">
  <a href="https://kolega.dev">Website</a> &middot;
  <a href="https://kolega.dev/docs">Docs</a> &middot;
  <a href="#install">Install</a> &middot;
  <a href="#quick-start">Quick Start</a>
</p>

---

## What is Kolega DevSec?

[Kolega DevSec](https://kolega.dev) is a security automation platform that goes beyond traditional SAST. It detects vulnerabilities with a two-tier engine — industry-standard SAST plus proprietary semantic analysis that catches logic flaws pattern-matching misses — then automatically generates merge-ready pull requests with tests included.

This CLI gives you full access to the Kolega DevSec API from your terminal: trigger scans, triage findings, kick off AI autofixes, and open pull requests — all without leaving the command line.

## Install

```sh
npm install -g @kolegaai/cli
```

Requires **Node 22** or later.

## Quick Start

```sh
# Authenticate (opens browser for device-flow pairing)
kolega auth login

# List your repositories
kolega repos list

# Run a secrets scan and wait for results
kolega scans start default --type secrets --wait

# See what's left in your quota
kolega quota
```

## Authentication

### Device flow (recommended)

```sh
kolega auth login
```

Opens a browser to pair this machine with your Kolega DevSec organization. Works on headless machines too — the CLI prints a URL and code you can enter from any device.

### API key (CI / non-interactive)

```sh
kolega auth login --token kcp_live_...
```

Or set the environment variable — it takes precedence over any stored config:

```sh
export KOLEGA_TOKEN=kcp_live_...
```

Credentials are stored in `~/.config/kolega/config.json` (respects `XDG_CONFIG_HOME`) with file mode `0600`. The token is never logged or included in error messages.

### Other auth commands

```sh
kolega auth status    # show org, API key + scopes, redacted token, and quota period
kolega auth logout    # remove stored credentials
```

## Commands

### Repositories

```sh
kolega repos list [--include-archived]
kolega repos get <repository-id>
```

> **Tip:** Most commands accept `default` as the repository ID, which auto-resolves to your only repository. If you have multiple, run `kolega repos list` and pass the ID explicitly.

### Scans

```sh
kolega scans list <repo-id> [--scan-type <type>] [--status <s>]
kolega scans start <repo-id> --type <secrets|semgrep|deep-ai|sbom> [--wait]
kolega scans get <repo-id> <scan-id>
kolega scans progress <repo-id> <scan-id> [--watch] [--interval <sec>]
kolega scans results <repo-id> <scan-id>
```

- **`--wait`** blocks after starting the scan, streaming a live progress bar until it completes. Ctrl+C detaches cleanly (the scan keeps running server-side).
- **`--watch`** on `progress` polls every 5 s and redraws in-place on TTYs.
- A **quota pre-check** runs before starting — skip with `--no-quota-check`.

### Findings

```sh
kolega findings list <repo-id> [--severity <s>] [--status <s>] [--scan-batch-id <id>]
kolega findings get <repo-id> <finding-id>
kolega findings set-status <repo-id> <finding-id> [status]
kolega findings events [--repo <id>] [--finding <id>] [--event-type <t>] [--since <iso>] [--until <iso>]
```

Omit the status argument on `set-status` and you'll be prompted interactively. Valid statuses: `open`, `resolved`, `ignored`, `false_positive`, `needs_manual_review`.

`findings events` lists the finding lifecycle audit trail (newest first) across the organization, optionally filtered to a single repository or finding.

### Fixes

```sh
kolega fixes run <repo-id> --finding-ids <id,id> --instructions "..." [--wait]
kolega fixes list <repo-id> [--finding-id <id>]
kolega fixes get <repo-id> <fix-id>
kolega fixes progress <repo-id> <fix-id> [--watch]
kolega fixes diff <repo-id> <fix-id>
kolega fixes refine <repo-id> <fix-id> --instructions "..." [--wait]
kolega fixes cancel <repo-id> <fix-id>
kolega fixes pr <repo-id> <fix-id> [--title <t>] [--body <b>] [--branch-name <n>]
```

- If `--instructions` is omitted, your `$EDITOR` opens for multi-line input.
- If `--source-repo` is omitted, the CLI auto-picks the repository's only source repo or prompts you to choose.
- `--wait` streams a live heartbeat (`status — 42s — 12 steps — last activity 3s ago`) until the fix completes.
- **`refine`** re-runs the agent on an existing fix with follow-up instructions; **`cancel`** stops a pending or running fix.

### Quota

```sh
kolega quota
```

Shows your current-period usage for PRs, SAST scans, deep AI scans, and repository slots.

## MCP Server (Claude Code, Cursor, Claude Desktop)

The CLI ships a [Model Context Protocol](https://modelcontextprotocol.io) server so coding agents can
scan repositories, triage findings, run AI autofixes and open pull requests directly from your
editor. It runs locally over stdio and reuses the same credentials as the CLI — authenticate once
with `kolega auth login` (or set `KOLEGA_TOKEN`) and every tool call is made on behalf of your
organization's API key.

```sh
# Claude Code
claude mcp add kolega -- npx -y @kolegaai/cli mcp

# Or, if the CLI is installed globally
claude mcp add kolega -- kolega mcp
```

For Cursor, Claude Desktop, Windsurf and other clients that read a JSON config:

```json
{
  "mcpServers": {
    "kolega": {
      "command": "npx",
      "args": ["-y", "@kolegaai/cli", "mcp"],
      "env": { "KOLEGA_TOKEN": "kcp_live_..." }
    }
  }
}
```

The `env` block is optional — omit it to use the token stored by `kolega auth login`. Set
`KOLEGA_API_URL` the same way to point at a non-production API.

### Tools

| Tool                                                                        | What it does                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `whoami`, `get_quota`                                                       | Identity behind the token; remaining scans/PRs/repository slots  |
| `list_repositories`, `get_repository`                                       | Repositories and their attached source repos                     |
| `list_scans`, `start_scan`, `get_scan_progress`, `get_scan_results`         | Run and monitor secrets / SAST / deep AI / SBOM scans            |
| `list_findings`, `get_finding`, `set_finding_status`, `list_finding_events` | Read and triage findings; audit trail                            |
| `list_fixes`, `run_fix`, `get_fix`, `get_fix_progress`, `get_fix_diff`      | Start an AI autofix and inspect the resulting diff               |
| `refine_fix`, `cancel_fix`, `create_pull_request`                           | Iterate on a fix, stop it, or open a PR on the source repository |

Every `repository_id` accepts `default` (see the tip under Repositories). Scans and fixes are
asynchronous: `start_scan`, `run_fix`, `refine_fix` and the `*_progress` tools take an optional
`wait_seconds` (max 120) to block briefly and return the latest progress; agents should poll the
progress tools until the status is terminal rather than assume completion.

Read-only tools are annotated `readOnlyHint` so clients can auto-approve them; `create_pull_request`
is flagged as an open-world action because it publishes to your source repository.

## Global Flags

| Flag              | Env var          | Description                                                   |
| ----------------- | ---------------- | ------------------------------------------------------------- |
| `--api-url <url>` | `KOLEGA_API_URL` | Override the API base URL (default: `https://api.kolega.dev`) |
| `--json`          |                  | Raw JSON to stdout — pipe to `jq` for scripting               |
|                   | `KOLEGA_TOKEN`   | API token; takes precedence over stored credentials           |
|                   | `NO_COLOR`       | Disable colored output                                        |

## JSON Mode

Every command supports `--json`. Output matches the Kolega DevSec API response schema exactly, so you can script against it:

```sh
# Get the first repository ID
kolega repos list --json | jq -r '.items[0].id'

# Count high-severity findings
kolega findings list default --severity high --json | jq '.total'

# Pipe a diff to a file
kolega fixes diff default <fix-id> --json | jq -r '.diff' > fix.patch
```

## Exit Codes

| Code | Meaning                   |
| ---- | ------------------------- |
| `0`  | Success                   |
| `1`  | Generic error             |
| `2`  | User interrupted (Ctrl+C) |
| `3`  | Quota exhausted           |
| `4`  | Not authenticated         |
| `5`  | API error                 |

## Development

```sh
git clone <repo>
cd kolega-dev-cli
npm install
npm run generate-types    # fetch OpenAPI spec + generate TypeScript types
npm run build
npm test
npm run lint
```

To regenerate types against a different backend:

```sh
KOLEGA_API_URL=https://api.kolegatestapps.com npm run generate-types
```

### Project Layout

```
src/
  cli.ts                  Commander entry point
  commands/               One file per resource group
  api/
    client.ts             Thin undici wrapper + ApiError
    auth-device-flow.ts   RFC 8628 device-grant state machine
    *.ts                  Typed wrappers per resource
  config/                 XDG-aware credential store (0600)
  ui/                     Tables, progress bars, error mapping
scripts/
  generate-types.ts       Fetches /api/v1/openapi.json → openapi-typescript
```

## License

MIT

---

<p align="center">
  Built for <a href="https://kolega.dev">Kolega DevSec</a>
</p>
