<h1 align="center">
  <code>@kolegaai/cli</code>
</h1>

<p align="center">
  <strong>The official CLI for <a href="https://kolega.dev">Kolega.dev</a></strong><br>
  Find and fix security vulnerabilities before they ship.
</p>

<p align="center">
  <a href="https://kolega.dev">Website</a> &middot;
  <a href="https://kolega.dev/docs">Docs</a> &middot;
  <a href="#install">Install</a> &middot;
  <a href="#quick-start">Quick Start</a>
</p>

---

## What is Kolega.dev?

[Kolega.dev](https://kolega.dev) is a security automation platform that goes beyond traditional SAST. It detects vulnerabilities with a two-tier engine — industry-standard SAST plus proprietary semantic analysis that catches logic flaws pattern-matching misses — then automatically generates merge-ready pull requests with tests included.

This CLI gives you full access to the Kolega.dev API from your terminal: trigger scans, triage findings, kick off AI autofixes, and open pull requests — all without leaving the command line.

## Install

```sh
npm install -g @kolegaai/cli
```

Requires **Node 22** or later.

## Quick Start

```sh
# Authenticate (opens browser for device-flow pairing)
kolega auth login

# List your applications
kolega apps list

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

Opens a browser to pair this machine with your Kolega.dev organization. Works on headless machines too — the CLI prints a URL and code you can enter from any device.

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
kolega auth status    # show redacted token, source, and org period
kolega auth logout    # remove stored credentials
```

## Commands

### Applications

```sh
kolega apps list [--include-archived]
kolega apps get <application-id>
```

> **Tip:** Most commands accept `default` as the application ID, which auto-resolves to your only application. If you have multiple, run `kolega apps list` and pass the ID explicitly.

### Scans

```sh
kolega scans list <app-id> [--scan-type <type>] [--status <s>]
kolega scans start <app-id> --type <secrets|semgrep|deep-ai|sbom> [--wait]
kolega scans get <app-id> <scan-id>
kolega scans progress <app-id> <scan-id> [--watch] [--interval <sec>]
kolega scans results <app-id> <scan-id>
```

- **`--wait`** blocks after starting the scan, streaming a live progress bar until it completes. Ctrl+C detaches cleanly (the scan keeps running server-side).
- **`--watch`** on `progress` polls every 5 s and redraws in-place on TTYs.
- A **quota pre-check** runs before starting — skip with `--no-quota-check`.

### Findings

```sh
kolega findings list <app-id> [--severity <s>] [--status <s>] [--scan-batch-id <id>]
kolega findings get <app-id> <finding-id>
kolega findings set-status <app-id> <finding-id> [status]
```

Omit the status argument on `set-status` and you'll be prompted interactively. Valid statuses: `open`, `resolved`, `ignored`, `false_positive`, `needs_manual_review`.

### Fixes

```sh
kolega fixes run <app-id> --finding-ids <id,id> --instructions "..." [--wait]
kolega fixes list <app-id> [--finding-id <id>]
kolega fixes get <app-id> <fix-id>
kolega fixes progress <app-id> <fix-id> [--watch]
kolega fixes diff <app-id> <fix-id>
kolega fixes pr <app-id> <fix-id> [--title <t>] [--body <b>] [--branch-name <n>]
```

- If `--instructions` is omitted, your `$EDITOR` opens for multi-line input.
- If `--source-repo` is omitted, the CLI auto-picks the application's only repo or prompts you to choose.
- `--wait` streams a live heartbeat (`status — 42s — 12 steps — last activity 3s ago`) until the fix completes.

### Quota

```sh
kolega quota
```

Shows your current-period usage for PRs, SAST scans, deep AI scans, and application slots.

## Global Flags

| Flag              | Env var          | Description                                                   |
| ----------------- | ---------------- | ------------------------------------------------------------- |
| `--api-url <url>` | `KOLEGA_API_URL` | Override the API base URL (default: `https://api.kolega.dev`) |
| `--json`          |                  | Raw JSON to stdout — pipe to `jq` for scripting               |
|                   | `KOLEGA_TOKEN`   | API token; takes precedence over stored credentials           |
|                   | `NO_COLOR`       | Disable colored output                                        |

## JSON Mode

Every command supports `--json`. Output matches the Kolega.dev API response schema exactly, so you can script against it:

```sh
# Get the first application ID
kolega apps list --json | jq -r '.items[0].id'

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
  Built for <a href="https://kolega.dev">Kolega.dev</a>
</p>
