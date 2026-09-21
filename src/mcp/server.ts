/**
 * Kolega DevSec MCP server.
 *
 * Exposes the public API as Model Context Protocol tools so coding agents
 * (Claude Code, Cursor, Claude Desktop, …) can list repositories, run scans,
 * triage findings, kick off AI autofixes, and open pull requests.
 *
 * The server is transport-agnostic: `createMcpServer` takes an already
 * authenticated `ApiClient` and returns an `McpServer`. The `kolega mcp`
 * command wires it to stdio; tests wire it to an in-memory transport.
 *
 * Design notes:
 * - Every tool returns the raw API JSON as text so the agent sees exactly
 *   the same shape `kolega … --json` prints.
 * - Long-running operations (`start_scan`, `run_fix`, `refine_fix`) return
 *   immediately by default. Callers can pass `wait_seconds` to block for a
 *   bounded time; the cap keeps us under typical MCP client timeouts.
 * - Read-only tools are annotated so clients can auto-approve them.
 * - API errors are returned as `isError` results (not thrown) so the agent
 *   can read the message and recover.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/client.js";
import { getMe } from "../api/me.js";
import { getQuotaBalance } from "../api/quotas.js";
import { getRepository, listRepositories, resolveRepositoryId } from "../api/repositories.js";
import { getScanProgress, getScanResults, listScans, startScan } from "../api/scans.js";
import { getFinding, listFindings, setFindingStatus } from "../api/findings.js";
import { listFindingEvents } from "../api/finding-events.js";
import {
  cancelFix,
  createFix,
  createFixPullRequests,
  getFix,
  getFixDiff,
  getFixProgress,
  listFixes,
  refineFix,
} from "../api/fixes.js";
import {
  FINDING_STATUSES,
  SCAN_TYPES,
  TERMINAL_FIX_STATUSES,
  TERMINAL_SCAN_STATUSES,
  type FindingStatus,
  type FixCreateRequest,
  type FixProgress,
  type ScanProgress,
  type ScanType,
} from "../api/types.js";

export const MCP_SERVER_NAME = "kolega-devsec";

/** Upper bound on how long a single tool call may block polling. */
export const MAX_WAIT_SECONDS = 120;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface McpServerOptions {
  client: ApiClient;
  version: string;
  /** Injected for tests so polling runs in zero wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const repositoryIdSchema = z
  .string()
  .min(1)
  .describe(
    'Kolega repository id. Pass "default" to auto-resolve when the organization has exactly one repository.',
  );

const paginationSchema = {
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50)."),
  skip: z.number().int().min(0).optional().describe("Number of items to skip."),
};

const waitSecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .optional()
  .describe(
    `Optional. Block up to this many seconds (max ${MAX_WAIT_SECONDS}) polling for completion, then return the latest progress. Omit to return immediately.`,
  );

const scanTypeSchema = z
  .enum(SCAN_TYPES as [ScanType, ...ScanType[]])
  .describe(
    "secrets_scan (leaked credentials), semgrep_scan (SAST), deep_ai_scan (semantic AI analysis, consumes a deep-scan credit), sbom_scan (dependency inventory).",
  );

const findingStatusSchema = z.enum(FINDING_STATUSES as [FindingStatus, ...FindingStatus[]]);

export function createMcpServer(options: McpServerOptions): McpServer {
  const { client, version } = options;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version },
    {
      instructions: [
        "Tools for the Kolega DevSec security platform: repositories, security scans, findings, AI autofixes and pull requests.",
        "Typical flow: list_repositories -> start_scan -> get_scan_progress (poll until terminal) -> list_findings -> run_fix -> get_fix_diff -> create_pull_request.",
        'Most tools take a repository_id; "default" works when the organization has a single repository.',
        "Scans and fixes run asynchronously on the server. Poll the *_progress tools rather than assuming completion.",
      ].join("\n"),
    },
  );

  const run = async (fn: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(err);
    }
  };

  const resolveRepo = (id: string): Promise<string> => resolveRepositoryId(client, id);

  // ---- identity & quota -------------------------------------------------

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Show the organization and API key behind the current credentials, including granted scopes.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => run(() => getMe(client)),
  );

  server.registerTool(
    "get_quota",
    {
      title: "Get quota balance",
      description:
        "Current-period quota: remaining pull requests, SAST scans, deep AI scans and repository slots. Check this before starting deep AI scans or fixes.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => run(() => getQuotaBalance(client)),
  );

  // ---- repositories -----------------------------------------------------

  server.registerTool(
    "list_repositories",
    {
      title: "List repositories",
      description:
        "List the repositories registered with Kolega DevSec for this organization. Each has an id used by the other tools and the attached source repos (owner/name on GitHub, GitLab or Azure DevOps).",
      inputSchema: {
        include_archived: z.boolean().optional().describe("Include archived repositories."),
        ...paginationSchema,
      },
      annotations: READ_ONLY,
    },
    ({ include_archived, limit, skip }) =>
      run(() => listRepositories(client, { includeArchived: include_archived, limit, skip })),
  );

  server.registerTool(
    "get_repository",
    {
      title: "Get repository",
      description: "Fetch a single repository by id, including its attached source repos.",
      inputSchema: { repository_id: repositoryIdSchema },
      annotations: READ_ONLY,
    },
    ({ repository_id }) => run(async () => getRepository(client, await resolveRepo(repository_id))),
  );

  // ---- scans ------------------------------------------------------------

  server.registerTool(
    "list_scans",
    {
      title: "List scans",
      description:
        "List scan batches for a repository, newest first. Filter by scan type or status.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        scan_type: scanTypeSchema.optional(),
        status: z.string().optional().describe("Filter by batch status, e.g. running, completed."),
        ...paginationSchema,
      },
      annotations: READ_ONLY,
    },
    ({ repository_id, scan_type, status, limit, skip }) =>
      run(async () =>
        listScans(client, await resolveRepo(repository_id), {
          scanType: scan_type,
          status,
          limit,
          skip,
        }),
      ),
  );

  server.registerTool(
    "start_scan",
    {
      title: "Start scan",
      description:
        "Start a security scan on a repository. Returns the scan batch (use batch_id with get_scan_progress / get_scan_results). deep_ai_scan consumes a deep-scan credit and can take many minutes; the others usually finish within a couple of minutes.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        scan_type: scanTypeSchema,
        wait_seconds: waitSecondsSchema,
      },
      annotations: WRITE,
    },
    ({ repository_id, scan_type, wait_seconds }) =>
      run(async () => {
        const repo = await resolveRepo(repository_id);
        const batch = await startScan(client, repo, { scan_type });
        if (!wait_seconds) return batch;
        const progress = await waitForScan(repo, batch.batch_id, wait_seconds);
        return { batch, progress };
      }),
  );

  server.registerTool(
    "get_scan_progress",
    {
      title: "Get scan progress",
      description:
        "Progress and status of a scan batch. Terminal statuses: " +
        TERMINAL_SCAN_STATUSES.join(", ") +
        ". Poll this until the status is terminal, then call get_scan_results.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        scan_id: z.string().min(1).describe("Scan batch id (batch_id from start_scan/list_scans)."),
        wait_seconds: waitSecondsSchema,
      },
      annotations: READ_ONLY,
    },
    ({ repository_id, scan_id, wait_seconds }) =>
      run(async () => {
        const repo = await resolveRepo(repository_id);
        if (!wait_seconds) return getScanProgress(client, repo, scan_id);
        return waitForScan(repo, scan_id, wait_seconds);
      }),
  );

  server.registerTool(
    "get_scan_results",
    {
      title: "Get scan results",
      description:
        "Findings summary for a completed scan batch. For full finding detail use list_findings with scan_batch_id.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        scan_id: z.string().min(1).describe("Scan batch id."),
      },
      annotations: READ_ONLY,
    },
    ({ repository_id, scan_id }) =>
      run(async () => getScanResults(client, await resolveRepo(repository_id), scan_id)),
  );

  // ---- findings ---------------------------------------------------------

  server.registerTool(
    "list_findings",
    {
      title: "List findings",
      description:
        "List security findings for a repository. Filter by severity (critical, high, medium, low, info), status, scan batch or scan type.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        severity: z.string().optional().describe("critical | high | medium | low | info"),
        status: findingStatusSchema.optional(),
        scan_batch_id: z.string().optional().describe("Only findings from this scan batch."),
        scan_type: scanTypeSchema.optional(),
        ...paginationSchema,
      },
      annotations: READ_ONLY,
    },
    ({ repository_id, severity, status, scan_batch_id, scan_type, limit, skip }) =>
      run(async () =>
        listFindings(client, await resolveRepo(repository_id), {
          severity,
          status,
          scanBatchId: scan_batch_id,
          scanType: scan_type,
          limit,
          skip,
        }),
      ),
  );

  server.registerTool(
    "get_finding",
    {
      title: "Get finding",
      description:
        "Full detail for one finding: file, line, CWE, description, remediation guidance and AI assessment.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        finding_id: z.string().min(1),
      },
      annotations: READ_ONLY,
    },
    ({ repository_id, finding_id }) =>
      run(async () => getFinding(client, await resolveRepo(repository_id), finding_id)),
  );

  server.registerTool(
    "set_finding_status",
    {
      title: "Set finding status",
      description:
        "Triage a finding by changing its status. Use false_positive or ignored to dismiss, resolved when fixed, needs_manual_review to flag for a human.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        finding_id: z.string().min(1),
        status: findingStatusSchema,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ repository_id, finding_id, status }) =>
      run(async () =>
        setFindingStatus(client, await resolveRepo(repository_id), finding_id, status),
      ),
  );

  server.registerTool(
    "list_finding_events",
    {
      title: "List finding events",
      description:
        "Audit trail of finding lifecycle events across the organization (newest first): created, status changes, fixes, etc. Optionally scope to a repository, finding, event type or time window.",
      inputSchema: {
        repository_id: repositoryIdSchema.optional(),
        finding_id: z.string().optional(),
        event_type: z.string().optional(),
        severity: z.string().optional(),
        scan_type: scanTypeSchema.optional(),
        since: z.string().optional().describe("ISO 8601 lower bound."),
        until: z.string().optional().describe("ISO 8601 upper bound."),
        ...paginationSchema,
      },
      annotations: READ_ONLY,
    },
    ({ repository_id, finding_id, event_type, severity, scan_type, since, until, limit, skip }) =>
      run(async () =>
        listFindingEvents(client, {
          repositoryId: repository_id ? await resolveRepo(repository_id) : undefined,
          findingId: finding_id,
          eventType: event_type,
          severity,
          scanType: scan_type,
          start: since,
          end: until,
          limit,
          skip,
        }),
      ),
  );

  // ---- fixes ------------------------------------------------------------

  server.registerTool(
    "list_fixes",
    {
      title: "List fixes",
      description: "List AI-generated fixes for a repository, optionally filtered to one finding.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        finding_id: z.string().optional(),
        ...paginationSchema,
      },
      annotations: READ_ONLY,
    },
    ({ repository_id, finding_id, limit, skip }) =>
      run(async () =>
        listFixes(client, await resolveRepo(repository_id), { findingId: finding_id, limit, skip }),
      ),
  );

  server.registerTool(
    "run_fix",
    {
      title: "Run AI fix",
      description:
        "Start an AI autofix for one or more findings. The agent clones the source repo, patches the code, and runs tests. Consumes a PR credit. Returns the fix (poll get_fix_progress, then get_fix_diff; open a PR with create_pull_request). source_repo is auto-resolved when the repository has exactly one attached source repo.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        finding_ids: z.array(z.string().min(1)).min(1).describe("Findings to fix together."),
        instructions: z
          .string()
          .min(1)
          .describe(
            "What the fix should do. Be specific about constraints and testing expectations.",
          ),
        title: z
          .string()
          .optional()
          .describe("Short title for the fix (defaults to a generic one)."),
        source_repo: z
          .string()
          .optional()
          .describe("Source repo full name (owner/repo). Auto-resolved if the repository has one."),
        source_repo_provider: z.enum(["github", "gitlab", "azure_devops"]).optional(),
        source_scan_branch: z.string().optional().describe("Branch the finding was detected on."),
        wait_seconds: waitSecondsSchema,
      },
      annotations: WRITE,
    },
    ({
      repository_id,
      finding_ids,
      instructions,
      title,
      source_repo,
      source_repo_provider,
      source_scan_branch,
      wait_seconds,
    }) =>
      run(async () => {
        const repo = await resolveRepo(repository_id);
        const source: SourceRepoRef = source_repo
          ? { fullName: source_repo, provider: source_repo_provider ?? "github" }
          : await resolveSourceRepo(client, repo);
        const body: FixCreateRequest = {
          finding_ids,
          title: title ?? "Kolega DevSec autofix",
          instructions,
          source_repo: source.fullName,
          source_repo_provider: source_repo_provider ?? source.provider,
          ...(source_scan_branch ? { source_scan_branch } : {}),
        };
        const fix = await createFix(client, repo, body);
        if (!wait_seconds) return fix;
        const progress = await waitForFix(repo, fix.id, wait_seconds);
        return { fix, progress };
      }),
  );

  server.registerTool(
    "get_fix",
    {
      title: "Get fix",
      description: "Fetch a fix by id, including any pull requests already opened for it.",
      inputSchema: { repository_id: repositoryIdSchema, fix_id: z.string().min(1) },
      annotations: READ_ONLY,
    },
    ({ repository_id, fix_id }) =>
      run(async () => getFix(client, await resolveRepo(repository_id), fix_id)),
  );

  server.registerTool(
    "get_fix_progress",
    {
      title: "Get fix progress",
      description:
        "Heartbeat for a running fix: status, steps completed, last activity. Terminal statuses: " +
        TERMINAL_FIX_STATUSES.join(", ") +
        ".",
      inputSchema: {
        repository_id: repositoryIdSchema,
        fix_id: z.string().min(1),
        wait_seconds: waitSecondsSchema,
      },
      annotations: READ_ONLY,
    },
    ({ repository_id, fix_id, wait_seconds }) =>
      run(async () => {
        const repo = await resolveRepo(repository_id);
        if (!wait_seconds) return getFixProgress(client, repo, fix_id);
        return waitForFix(repo, fix_id, wait_seconds);
      }),
  );

  server.registerTool(
    "get_fix_diff",
    {
      title: "Get fix diff",
      description:
        "Unified diff produced by a fix. diff is null while the fix is still running. Review this before opening a pull request.",
      inputSchema: { repository_id: repositoryIdSchema, fix_id: z.string().min(1) },
      annotations: READ_ONLY,
    },
    ({ repository_id, fix_id }) =>
      run(async () => getFixDiff(client, await resolveRepo(repository_id), fix_id)),
  );

  server.registerTool(
    "refine_fix",
    {
      title: "Refine fix",
      description:
        "Re-run the fix agent on an existing fix with follow-up instructions (e.g. after reviewing the diff). Consumes a PR credit.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        fix_id: z.string().min(1),
        instructions: z.string().min(1),
        wait_seconds: waitSecondsSchema,
      },
      annotations: WRITE,
    },
    ({ repository_id, fix_id, instructions, wait_seconds }) =>
      run(async () => {
        const repo = await resolveRepo(repository_id);
        const fix = await refineFix(client, repo, fix_id, { instructions });
        if (!wait_seconds) return fix;
        const progress = await waitForFix(repo, fix.id, wait_seconds);
        return { fix, progress };
      }),
  );

  server.registerTool(
    "cancel_fix",
    {
      title: "Cancel fix",
      description: "Stop a pending or running fix.",
      inputSchema: { repository_id: repositoryIdSchema, fix_id: z.string().min(1) },
      annotations: { ...WRITE, destructiveHint: true },
    },
    ({ repository_id, fix_id }) =>
      run(async () => cancelFix(client, await resolveRepo(repository_id), fix_id)),
  );

  server.registerTool(
    "create_pull_request",
    {
      title: "Create pull request",
      description:
        "Open a pull request on the source repo from a completed fix. Title, body and branch name are auto-generated when omitted. This is visible to everyone with access to the source repo.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        fix_id: z.string().min(1),
        title: z.string().optional(),
        body: z.string().optional().describe("PR description in markdown."),
        branch_name: z.string().optional(),
      },
      annotations: { ...WRITE, openWorldHint: true },
    },
    ({ repository_id, fix_id, title, body, branch_name }) =>
      run(async () =>
        createFixPullRequests(client, await resolveRepo(repository_id), fix_id, {
          ...(title ? { title } : {}),
          ...(body ? { body } : {}),
          ...(branch_name ? { branch_name } : {}),
        }),
      ),
  );

  // ---- helpers ----------------------------------------------------------

  async function waitForScan(
    repo: string,
    scanId: string,
    waitSeconds: number,
  ): Promise<ScanProgress> {
    const deadline = Date.now() + waitSeconds * 1000;
    while (true) {
      const progress = await getScanProgress(client, repo, scanId);
      if (TERMINAL_SCAN_STATUSES.includes(progress.status.toLowerCase())) return progress;
      if (Date.now() >= deadline) return progress;
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
  }

  async function waitForFix(
    repo: string,
    fixId: string,
    waitSeconds: number,
  ): Promise<FixProgress> {
    const deadline = Date.now() + waitSeconds * 1000;
    while (true) {
      const progress = await getFixProgress(client, repo, fixId);
      if (TERMINAL_FIX_STATUSES.includes(progress.status.toLowerCase())) return progress;
      if (Date.now() >= deadline) return progress;
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
  }

  return server;
}

interface SourceRepoRef {
  fullName: string;
  provider: "github" | "gitlab" | "azure_devops";
}

/**
 * Picks the source repo for a fix when the caller didn't specify one. Unlike
 * the CLI we can't prompt, so more than one attached repo is an error that
 * tells the agent what to pass.
 */
async function resolveSourceRepo(client: ApiClient, repositoryId: string): Promise<SourceRepoRef> {
  const repository = await getRepository(client, repositoryId);
  const repos = repository.repositories ?? [];
  if (repos.length === 0) {
    throw new ApiError(
      "This repository has no source repositories attached. Pass source_repo (owner/repo).",
      { status: 400, errorCode: "NO_SOURCE_REPO" },
    );
  }
  if (repos.length > 1) {
    throw new ApiError(
      `This repository has ${repos.length} source repos; pass source_repo as one of: ${repos
        .map((r) => r.full_name)
        .join(", ")}.`,
      { status: 400, errorCode: "MULTIPLE_SOURCE_REPOS" },
    );
  }
  const ref = repos[0]!;
  return { fullName: ref.full_name, provider: toProvider(ref.provider) };
}

function toProvider(input: string): SourceRepoRef["provider"] {
  const normalized = input.toLowerCase();
  if (normalized === "github" || normalized === "gitlab" || normalized === "azure_devops") {
    return normalized;
  }
  return "github";
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: describeError(err) }] };
}

/**
 * Human/agent-readable error text. Never includes the bearer token — the
 * ApiClient already strips it — but we also avoid dumping raw response
 * bodies beyond the structured `detail` the API returns.
 */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.errorCode === "OPERATION_FAILED" && err.quotaType) {
      const detail = err.detail as { period_end?: string } | undefined;
      const when = detail?.period_end ? ` Quota resets at ${detail.period_end}.` : "";
      return `Quota exhausted: no ${err.quotaType} remaining for this period.${when}`;
    }
    if (err.status === 401) {
      return "Not authenticated: the Kolega API token is missing, expired or revoked. Run `kolega auth login` or set KOLEGA_TOKEN.";
    }
    if (err.status === 403) {
      return `Forbidden: ${err.message} (the API key may lack the required scope).`;
    }
    const code = err.errorCode ? ` [${err.errorCode}]` : "";
    const detail =
      err.detail !== undefined && typeof err.detail !== "string"
        ? `\n${JSON.stringify(err.detail, null, 2)}`
        : "";
    return `API error ${err.status}${code}: ${err.message}${detail}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
