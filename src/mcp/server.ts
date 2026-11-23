/**
 * Kolega DevSec MCP server.
 *
 * Exposes the public API as Model Context Protocol tools so coding agents
 * (Claude Code, Cursor, Claude Desktop, …) can list repositories, run scans,
 * triage findings, kick off AI autofixes, and open pull requests.
 *
 * The server is transport-agnostic: `createMcpServer` takes an already
 * authenticated `ApiClient` and returns an `McpServer`. The `kolega mcp`
 * command wires it to stdio; tests wire it to an in-memory transport; the
 * hosted server (`@kolegaai/cli/mcp`) builds one per HTTP request.
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
import {
  addPublicRepository,
  getRepository,
  listRepositories,
  resolveRepositoryId,
} from "../api/repositories.js";
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
  DAILY_CAPACITY_QUOTA_TYPE,
  FINDING_STATUS_REASON_MAX_LENGTH,
  FINDING_STATUSES,
  SCAN_TYPES,
  TERMINAL_FIX_STATUSES,
  TERMINAL_SCAN_STATUSES,
  type FindingStatus,
  type FixCreateRequest,
  type FixProgress,
  type PublicRepositoryAddResponse,
  type ScanBatch,
  type ScanProgress,
  type ScanType,
} from "../api/types.js";

export const MCP_SERVER_NAME = "kolega-devsec";

/** Upper bound on how long a single tool call may block polling. */
// Below the 60s request timeout many MCP clients default to; call again to keep waiting.
export const MAX_WAIT_SECONDS = 45;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface McpServerOptions {
  client: ApiClient;
  version: string;
  /** Injected for tests so polling runs in zero wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  /**
   * What to tell the agent when the API rejects the token. Defaults to the
   * local CLI advice; the hosted server swaps in advice to reconnect.
   */
  reauthHint?: string;
}

export const DEFAULT_REAUTH_HINT = "Run `kolega auth login` or set KOLEGA_TOKEN.";

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

const pagination = (defaultLimit: number) => ({
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(`Page size (default ${defaultLimit}).`),
  skip: z.number().int().min(0).optional().describe("Number of items to skip."),
});

const SCAN_ID_DESCRIPTION =
  "Scan batch id: scan_id from start_scan or scan_public_repo (batch_id in list_scans).";

const scanNextStep = (repositoryId: string, scanId: string): string =>
  `Poll get_scan_progress with repository_id "${repositoryId}" and scan_id "${scanId}" until the batch status is completed, partial_failure or failed, then call get_scan_results.`;

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const severitySchema = z
  .preprocess(
    (value) => (typeof value === "string" ? value.toLowerCase() : value),
    z.enum(SEVERITIES),
  )
  .describe("critical | high | medium | low | info");

const waitSecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .optional()
  .describe(
    `Optional. Block up to this many seconds (max ${MAX_WAIT_SECONDS}) polling for completion, then return the latest progress; call again to keep waiting. Omit to return immediately.`,
  );

const detailSchema = z
  .boolean()
  .optional()
  .describe(
    "Return full finding objects. By default each finding is compact: id, severity, status, title, file_path, line_start, check_id.",
  );

interface FindingLike {
  id?: string;
  severity: string;
  status?: string;
  title?: string | null;
  message: string;
  category?: string | null;
  file_path: string;
  line_start?: number | null;
  manifest_paths?: string[];
  check_id: string;
}

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const compactFinding = (f: FindingLike) => ({
  id: f.id,
  severity: f.severity,
  status: f.status,
  title: f.title || truncate(f.message, 120),
  file_path: f.file_path,
  line_start: f.line_start ?? null,
  check_id: f.check_id,
  // SBOM findings: file_path is the package URL; these say where it's declared.
  ...(f.manifest_paths?.length ? { manifest_paths: f.manifest_paths } : {}),
  ...(f.category === "license" ? { category: f.category } : {}),
});

interface FindingEventLike {
  id: string;
  event_type: string;
  finding_id: string;
  severity?: string | null;
  previous_status?: string | null;
  new_status?: string | null;
  actor_user_id?: string | null;
  metadata?: Record<string, unknown>;
  event_timestamp: string;
}

const compactEvent = (e: FindingEventLike) => {
  const reason =
    typeof e.metadata?.reason === "string" ? truncate(e.metadata.reason, 200) : undefined;
  const changedBy = typeof e.metadata?.changed_by === "string" ? e.metadata.changed_by : undefined;
  return {
    id: e.id,
    event_type: e.event_type,
    finding_id: e.finding_id,
    severity: e.severity ?? null,
    previous_status: e.previous_status ?? null,
    new_status: e.new_status ?? null,
    actor: changedBy ?? e.actor_user_id ?? null,
    ...(reason ? { reason } : {}),
    event_timestamp: e.event_timestamp,
  };
};

const scanTypeSchema = z
  .enum(SCAN_TYPES as [ScanType, ...ScanType[]])
  .describe(
    "secrets_scan (leaked credentials) and semgrep_scan (SAST) use the SAST scan allowance; deep_ai_scan (semantic AI analysis) uses a deep-scan credit; sbom_scan (dependency inventory) is not metered. Scans of public repositories added with scan_public_repo use the separate public allowances.",
  );

const findingStatusSchema = z.enum(FINDING_STATUSES as [FindingStatus, ...FindingStatus[]]);

export function createMcpServer(options: McpServerOptions): McpServer {
  const { client, version } = options;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const reauthHint = options.reauthHint ?? DEFAULT_REAUTH_HINT;

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version },
    {
      instructions: [
        "Tools for the Kolega DevSec security platform: repositories, security scans, findings, AI autofixes and pull requests.",
        "Typical flow: list_repositories -> start_scan -> get_scan_progress (poll until terminal) -> list_findings -> run_fix -> get_fix_diff -> create_pull_request.",
        "To scan any public GitHub repository (e.g. an open-source dependency), use scan_public_repo, then poll get_scan_progress.",
        'Most tools take a repository_id; "default" works when the organization has a single repository.',
        "Scans and fixes run asynchronously on the server. Poll the *_progress tools rather than assuming completion.",
      ].join("\n"),
    },
  );

  const run = async (fn: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(err, reauthHint);
    }
  };

  const resolveRepo = async (id: string): Promise<string> => {
    try {
      return await resolveRepositoryId(client, id);
    } catch (err) {
      if (err instanceof ApiError && err.errorCode === "MULTIPLE_REPOSITORIES") {
        throw new ApiError(
          'This organization has several repositories, so "default" is ambiguous. Call list_repositories and pass a repository_id.',
          { status: err.status, errorCode: err.errorCode },
        );
      }
      throw err;
    }
  };

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
        "Current-period quota: remaining pull requests, SAST scans, deep AI scans, scans of public repositories (a separate allowance) and repository slots. repositories.current counts the organization's own repositories only, not public ones added with scan_public_repo. Check this before starting deep AI scans or opening pull requests.",
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
        ...pagination(50),
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
        ...pagination(20),
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
        "Start a security scan on a repository. Returns the scan batch with scan_id (the same value as batch_id) to use with get_scan_progress and get_scan_results, a link to the results in the web app, and the next step. deep_ai_scan uses a deep-scan credit and can take many minutes; the others usually finish within a couple of minutes.",
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
        const started = {
          ...batch,
          scan_id: batch.batch_id,
          next_step: scanNextStep(repo, batch.batch_id),
        };
        if (!wait_seconds) return started;
        const progress = await waitForScan(repo, batch.batch_id, wait_seconds);
        return { batch: started, progress };
      }),
  );

  server.registerTool(
    "scan_public_repo",
    {
      title: "Scan a public repository",
      description:
        "Scan any public GitHub repository, such as an open-source project or dependency, without connecting it first. Adds the repository to the organization (or reuses it if already added) and starts a scan. Public repositories have their own monthly scan allowance (public_sast_scans and public_deep_ai_scans in get_quota), separate from the organization's own repositories. deep_ai_scan (the default) finds more but can take many minutes and uses a public deep-scan credit; semgrep_scan is faster. Returns the repository_id and scan_id to use with get_scan_progress and get_scan_results, plus a link to the results in the web app.",
      inputSchema: {
        repository: z
          .string()
          .min(1)
          .max(300)
          .describe("Public GitHub repository as owner/repo or a github.com URL."),
        scan_type: scanTypeSchema.optional().describe("Defaults to deep_ai_scan."),
        branch: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Branch to scan. Defaults to the repository's default branch."),
        wait_seconds: waitSecondsSchema,
      },
      annotations: { ...WRITE, openWorldHint: true },
    },
    async ({ repository, scan_type, branch, wait_seconds }) => {
      let added: PublicRepositoryAddResponse;
      try {
        added = await addPublicRepository(client, branch ? { repository, branch } : { repository });
      } catch (err) {
        return fail(err, reauthHint);
      }
      const source = added.repositories?.[0]?.full_name ?? added.name;
      let batch: ScanBatch;
      try {
        batch = await startScan(client, added.id, { scan_type: scan_type ?? "deep_ai_scan" });
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `${source} was added as repository_id "${added.id}", but the scan did not start. ${describeError(err, reauthHint)}`,
            },
          ],
        };
      }
      const result = {
        repository_id: added.id,
        repository: source,
        repository_added: added.created,
        scan_id: batch.batch_id,
        scan_type: batch.scan_type,
        status: batch.status,
        app_url: added.app_url,
        next_step: scanNextStep(added.id, batch.batch_id),
      };
      if (!wait_seconds) return ok(result);
      return run(async () => ({
        ...result,
        progress: await waitForScan(added.id, batch.batch_id, wait_seconds),
      }));
    },
  );

  server.registerTool(
    "get_scan_progress",
    {
      title: "Get scan progress",
      description:
        "Progress and status of a scan batch. Poll this until the batch status is completed, partial_failure or failed, then call get_scan_results. Go by the batch's own status: its repositories reach succeeded first, while AI assessment is still triaging the findings, and their findings_count is raw detections before de-duplication and triage, so it can differ from the results.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        scan_id: z.string().min(1).describe(SCAN_ID_DESCRIPTION),
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
        "Findings for a scan batch, each with its status: open and needs_manual_review need attention; false_positive, ignored and resolved do not (AI assessment marks false positives). Report open findings separately from dismissed ones. status_counts, severity_counts and actionable_severity_counts (open or needs_manual_review only) give the totals. If assessment_complete is false the scan is still running or being assessed, so more findings may appear and statuses may change: wait with get_scan_progress first. Use a finding's id with get_finding or run_fix.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        scan_id: z.string().min(1).describe(SCAN_ID_DESCRIPTION),
        detail: detailSchema,
      },
      annotations: READ_ONLY,
    },
    ({ repository_id, scan_id, detail }) =>
      run(async () => {
        const results = await getScanResults(client, await resolveRepo(repository_id), scan_id);
        return detail ? results : { ...results, findings: results.findings.map(compactFinding) };
      }),
  );

  // ---- findings ---------------------------------------------------------

  server.registerTool(
    "list_findings",
    {
      title: "List findings",
      description:
        "List security findings for a repository. Filter by severity (critical, high, medium, low, info), status (open and needs_manual_review need attention), scan batch or scan type. Use get_finding for one finding in full.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        severity: severitySchema.optional(),
        status: findingStatusSchema.optional(),
        scan_batch_id: z.string().optional().describe("Only findings from this scan batch."),
        scan_type: scanTypeSchema.optional(),
        category: z
          .string()
          .optional()
          .describe(
            "dependency or license (SBOM vulnerability or license-policy findings), secrets, or security.",
          ),
        detail: detailSchema,
        ...pagination(50),
      },
      annotations: READ_ONLY,
    },
    ({
      repository_id,
      severity,
      status,
      scan_batch_id,
      scan_type,
      category,
      detail,
      limit,
      skip,
    }) =>
      run(async () => {
        const page = await listFindings(client, await resolveRepo(repository_id), {
          severity,
          status,
          scanBatchId: scan_batch_id,
          scanType: scan_type,
          category,
          limit,
          skip,
        });
        return detail ? page : { ...page, items: page.items.map(compactFinding) };
      }),
  );

  server.registerTool(
    "get_finding",
    {
      title: "Get finding",
      description:
        "Full detail for one finding: status, file and lines, description, CWE/OWASP, references, CVSS, and the AI assessment (including why it was dismissed, if it was).",
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
        "Triage a finding by changing its status. Use false_positive or ignored to dismiss, resolved when fixed, needs_manual_review to flag for a human. Give a reason when closing a finding (resolved, ignored or false_positive): it is saved to the audit trail, and some organizations require it.",
      inputSchema: {
        repository_id: repositoryIdSchema,
        finding_id: z.string().min(1),
        status: findingStatusSchema,
        reason: z
          .string()
          .trim()
          .min(1)
          .max(FINDING_STATUS_REASON_MAX_LENGTH)
          .optional()
          .describe(
            "Why the status is being set, e.g. why this is a false positive or how it was resolved. Required by some organizations to close a finding.",
          ),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ repository_id, finding_id, status, reason }) =>
      run(async () =>
        setFindingStatus(client, await resolveRepo(repository_id), finding_id, status, reason),
      ),
  );

  server.registerTool(
    "list_finding_events",
    {
      title: "List finding events",
      description:
        "Audit trail of finding lifecycle events across the organization (newest first): detected, status changes (including AI triage dismissals), fixes, etc. Optionally scope to a repository, finding, event type or time window. An event's scan_id is the individual repository scan, not the scan batch id the other tools use.",
      inputSchema: {
        repository_id: repositoryIdSchema.optional(),
        finding_id: z.string().optional(),
        event_type: z.string().optional(),
        severity: severitySchema.optional(),
        scan_type: scanTypeSchema.optional(),
        since: z.string().optional().describe("ISO 8601 lower bound."),
        until: z.string().optional().describe("ISO 8601 upper bound."),
        detail: z
          .boolean()
          .optional()
          .describe(
            "Return full event objects. By default each event is compact: id, event_type, finding_id, severity, previous_status, new_status, actor, reason, event_timestamp.",
          ),
        ...pagination(100),
      },
      annotations: READ_ONLY,
    },
    ({
      repository_id,
      finding_id,
      event_type,
      severity,
      scan_type,
      since,
      until,
      detail,
      limit,
      skip,
    }) =>
      run(async () => {
        const page = await listFindingEvents(client, {
          repositoryId: repository_id ? await resolveRepo(repository_id) : undefined,
          findingId: finding_id,
          eventType: event_type,
          severity,
          scanType: scan_type,
          start: since,
          end: until,
          limit,
          skip,
        });
        return detail ? page : { ...page, items: page.items.map(compactEvent) };
      }),
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
        ...pagination(50),
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
        "Start an AI autofix for one or more findings. The agent clones the source repo, patches the code, and runs tests. Doesn't use a quota credit. Returns the fix (poll get_fix_progress, then get_fix_diff; open a PR with create_pull_request, which uses a pull-request credit). source_repo is auto-resolved when the repository has exactly one attached source repo.",
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
        "Re-run the fix agent on an existing fix with follow-up instructions (e.g. after reviewing the diff). The new diff replaces the old one on the same fix id; earlier diffs aren't kept. Doesn't use a quota credit.",
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
        "Open a pull request on the source repo from a completed fix. Title, body and branch name are auto-generated when omitted. Uses one pull-request credit. This is visible to everyone with access to the source repo. Not available for public repositories added with scan_public_repo, which are read-only: share the diff from get_fix_diff instead.",
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

export function fail(err: unknown, reauthHint: string = DEFAULT_REAUTH_HINT): CallToolResult {
  return { isError: true, content: [{ type: "text", text: describeError(err, reauthHint) }] };
}

/**
 * Human/agent-readable error text. Never includes the bearer token — the
 * ApiClient already strips it — but we also avoid dumping raw response
 * bodies beyond the structured `detail` the API returns.
 */
export function describeError(err: unknown, reauthHint: string = DEFAULT_REAUTH_HINT): string {
  if (err instanceof ApiError) {
    if (err.errorCode === "OPERATION_FAILED" && err.quotaType === DAILY_CAPACITY_QUOTA_TYPE) {
      return `Limit reached: ${err.message}`;
    }
    if (err.errorCode === "OPERATION_FAILED" && err.quotaType) {
      const detail = err.detail as { period_end?: string } | undefined;
      const when = detail?.period_end ? ` Quota resets at ${detail.period_end}.` : "";
      return `Quota exhausted: no ${err.quotaType} remaining for this period.${when}`;
    }
    if (err.status === 401) {
      return `Not authenticated: the Kolega API token is missing, expired or revoked. ${reauthHint}`;
    }
    if (err.status === 403) {
      return `Forbidden: ${err.message} (the API key may lack the required scope).`;
    }
    if (err.errorCode === "FINDING_CLOSURE_REASON_REQUIRED") {
      return `${err.message} Call set_finding_status again with a "reason" explaining why the finding is being closed.`;
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
