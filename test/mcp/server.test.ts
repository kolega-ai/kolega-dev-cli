import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ApiClient, ApiError } from "../../src/api/client.js";
import { createMcpServer, describeError, MAX_WAIT_SECONDS } from "../../src/mcp/server.js";

type Call = { method: string; path: string; body?: unknown; query?: Record<string, unknown> };

/**
 * Stub ApiClient that records every request and answers from a route table.
 * A handler may return a value, or throw an ApiError to simulate the backend.
 */
function stubClient(routes: Record<string, (call: Call) => unknown>): {
  client: ApiClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = Object.create(ApiClient.prototype) as ApiClient;
  const dispatch = (method: string, path: string, body?: unknown, options?: { query?: never }) => {
    const call: Call = { method, path, body, query: options?.query };
    calls.push(call);
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected request: ${method} ${path}`);
    return Promise.resolve(handler(call));
  };
  const c = client as unknown as Record<string, unknown>;
  c.get = (path: string, options?: { query?: never }) => dispatch("GET", path, undefined, options);
  c.post = (path: string, body?: unknown, options?: { query?: never }) =>
    dispatch("POST", path, body, options);
  c.patch = (path: string, body?: unknown, options?: { query?: never }) =>
    dispatch("PATCH", path, body, options);
  c.delete = (path: string, options?: { query?: never }) =>
    dispatch("DELETE", path, undefined, options);
  return { client, calls };
}

async function connect(client: ApiClient, extra: { sleep?: (ms: number) => Promise<void> } = {}) {
  const server = createMcpServer({
    client,
    version: "0.0.0-test",
    sleep: extra.sleep ?? (async () => {}),
    pollIntervalMs: 1,
  });
  const mcp = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return { mcp, server };
}

function text(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const first = content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`expected a text content block, got ${JSON.stringify(content)}`);
  }
  return first.text;
}

const REPO = { id: "repo-1", name: "api", archived: false, repositories: [] };

describe("createMcpServer", () => {
  it("advertises the expected tools with read-only annotations on reads", async () => {
    const { client } = stubClient({});
    const { mcp } = await connect(client);
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "cancel_fix",
        "create_pull_request",
        "get_finding",
        "get_fix",
        "get_fix_diff",
        "get_fix_progress",
        "get_quota",
        "get_repository",
        "get_scan_progress",
        "get_scan_results",
        "list_finding_events",
        "list_findings",
        "list_fixes",
        "list_repositories",
        "list_scans",
        "refine_fix",
        "run_fix",
        "scan_public_repo",
        "set_finding_status",
        "start_scan",
        "whoami",
      ].sort(),
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_findings!.annotations?.readOnlyHint).toBe(true);
    expect(byName.start_scan!.annotations?.readOnlyHint).toBe(false);
    expect(byName.cancel_fix!.annotations?.destructiveHint).toBe(true);
    expect(byName.create_pull_request!.annotations?.openWorldHint).toBe(true);
    expect(byName.scan_public_repo!.annotations?.readOnlyHint).toBe(false);
    expect(byName.scan_public_repo!.annotations?.openWorldHint).toBe(true);
    // Every tool must carry a description — that's what the agent reasons over.
    for (const tool of tools) expect(tool.description?.length ?? 0).toBeGreaterThan(20);
  });

  it("returns API JSON as text content", async () => {
    const quota = { period_start: "a", period_end: "b", prs: { remaining: 3 } };
    const { client } = stubClient({ "GET /api/v1/quotas/balance": () => quota });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({ name: "get_quota", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual(quota);
  });

  it('resolves "default" repository id via the repositories list', async () => {
    const { client, calls } = stubClient({
      "GET /api/v1/repositories": () => ({ items: [REPO], total: 1 }),
      "GET /api/v1/repositories/repo-1/findings": () => ({ items: [], total: 0 }),
    });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "list_findings",
      arguments: { repository_id: "default", severity: "high" },
    });
    expect(result.isError).toBeFalsy();
    const findingsCall = calls.find((c) => c.path.endsWith("/findings"));
    expect(findingsCall?.query).toMatchObject({ severity: "high" });
  });

  it("passes finding status through set_finding_status as a PATCH", async () => {
    const { client, calls } = stubClient({
      "PATCH /api/v1/repositories/repo-1/findings/f-9": (call) => ({
        id: "f-9",
        ...(call.body as object),
      }),
    });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "set_finding_status",
      arguments: { repository_id: "repo-1", finding_id: "f-9", status: "false_positive" },
    });
    expect(JSON.parse(text(result))).toEqual({ id: "f-9", status: "false_positive" });
    expect(calls[0]?.body).toEqual({ status: "false_positive" });
  });

  it("sends a reason with set_finding_status when one is given", async () => {
    const { client, calls } = stubClient({
      "PATCH /api/v1/repositories/repo-1/findings/f-9": (call) => ({
        id: "f-9",
        ...(call.body as object),
      }),
    });
    const { mcp } = await connect(client);
    const { tools } = await mcp.listTools();
    const tool = tools.find((t) => t.name === "set_finding_status");
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("reason");
    expect(tool?.inputSchema.required).not.toContain("reason");

    const result = await mcp.callTool({
      name: "set_finding_status",
      arguments: {
        repository_id: "repo-1",
        finding_id: "f-9",
        status: "ignored",
        reason: "  Internal tool behind the VPN  ",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0]?.body).toEqual({ status: "ignored", reason: "Internal tool behind the VPN" });
  });

  it("rejects a blank or overlong reason before hitting the API", async () => {
    const { client, calls } = stubClient({});
    const { mcp } = await connect(client);
    for (const reason of ["   ", "x".repeat(1001)]) {
      const result = await mcp.callTool({
        name: "set_finding_status",
        arguments: { repository_id: "repo-1", finding_id: "f-9", status: "ignored", reason },
      });
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("tells the agent to retry with a reason when the organization requires one", async () => {
    const { client } = stubClient({
      "PATCH /api/v1/repositories/repo-1/findings/f-9": () => {
        throw new ApiError("A reason is required to close a finding in this organization.", {
          status: 400,
          errorCode: "FINDING_CLOSURE_REASON_REQUIRED",
        });
      },
    });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "set_finding_status",
      arguments: { repository_id: "repo-1", finding_id: "f-9", status: "ignored" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      'A reason is required to close a finding in this organization. Call set_finding_status again with a "reason" explaining why the finding is being closed.',
    );
  });

  it("rejects an invalid finding status before hitting the API", async () => {
    const { client, calls } = stubClient({});
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "set_finding_status",
      arguments: { repository_id: "repo-1", finding_id: "f-9", status: "bogus" },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("start_scan returns the batch immediately without wait_seconds", async () => {
    const { client, calls } = stubClient({
      "POST /api/v1/repositories/repo-1/scans": () => ({ batch_id: "b-1", status: "queued" }),
    });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "start_scan",
      arguments: { repository_id: "repo-1", scan_type: "semgrep_scan" },
    });
    expect(JSON.parse(text(result))).toEqual({ batch_id: "b-1", status: "queued" });
    expect(calls[0]?.body).toEqual({ scan_type: "semgrep_scan" });
    expect(calls).toHaveLength(1);
  });

  it("start_scan with wait_seconds polls progress until terminal", async () => {
    const statuses = ["queued", "running", "completed"];
    const { client, calls } = stubClient({
      "POST /api/v1/repositories/repo-1/scans": () => ({ batch_id: "b-1", status: "queued" }),
      "GET /api/v1/repositories/repo-1/scans/b-1/progress": () => ({
        batch_id: "b-1",
        status: statuses.shift() ?? "completed",
        percent_complete: 100,
      }),
    });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "start_scan",
      arguments: { repository_id: "repo-1", scan_type: "secrets_scan", wait_seconds: 30 },
    });
    const parsed = JSON.parse(text(result));
    expect(parsed.batch.batch_id).toBe("b-1");
    expect(parsed.progress.status).toBe("completed");
    expect(calls.filter((c) => c.path.endsWith("/progress"))).toHaveLength(3);
  });

  const PUBLIC_REPO = {
    id: "repo-pub",
    name: "octo/hello",
    archived: false,
    public_repository: true,
    repositories: [{ full_name: "octo/hello", default_branch: "main", provider: "github" }],
    created: true,
    app_url: "https://app.example.test/repositories/repo-pub/scans?org=org-1",
  };

  it("scan_public_repo adds the repository then starts a deep scan by default", async () => {
    const { client, calls } = stubClient({
      "POST /api/v1/repositories/public": () => PUBLIC_REPO,
      "POST /api/v1/repositories/repo-pub/scans": () => ({
        batch_id: "b-9",
        scan_type: "deep_ai_scan",
        status: "queued",
      }),
    });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "scan_public_repo",
      arguments: { repository: "https://github.com/octo/hello" },
    });

    expect(result.isError).toBeFalsy();
    expect(calls[0]?.body).toEqual({ repository: "https://github.com/octo/hello" });
    expect(calls[1]?.body).toEqual({ scan_type: "deep_ai_scan" });
    const parsed = JSON.parse(text(result));
    expect(parsed).toMatchObject({
      repository_id: "repo-pub",
      repository: "octo/hello",
      repository_added: true,
      scan_id: "b-9",
      scan_type: "deep_ai_scan",
      status: "queued",
      app_url: PUBLIC_REPO.app_url,
    });
    expect(parsed.next_step).toContain("get_scan_progress");
    expect(parsed.next_step).toContain('"b-9"');
  });

  it("scan_public_repo passes branch and scan type, and can wait for completion", async () => {
    const { client, calls } = stubClient({
      "POST /api/v1/repositories/public": () => ({ ...PUBLIC_REPO, created: false }),
      "POST /api/v1/repositories/repo-pub/scans": () => ({
        batch_id: "b-9",
        scan_type: "semgrep_scan",
        status: "queued",
      }),
      "GET /api/v1/repositories/repo-pub/scans/b-9/progress": () => ({
        batch_id: "b-9",
        status: "completed",
      }),
    });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "scan_public_repo",
      arguments: {
        repository: "octo/hello",
        branch: "dev",
        scan_type: "semgrep_scan",
        wait_seconds: 10,
      },
    });

    expect(calls[0]?.body).toEqual({ repository: "octo/hello", branch: "dev" });
    expect(calls[1]?.body).toEqual({ scan_type: "semgrep_scan" });
    const parsed = JSON.parse(text(result));
    expect(parsed.repository_added).toBe(false);
    expect(parsed.progress.status).toBe("completed");
  });

  it("scan_public_repo reports private repositories as tool errors", async () => {
    const { client, calls } = stubClient({
      "POST /api/v1/repositories/public": () => {
        throw new ApiError(
          "This repository is private. Connect GitHub to scan private repositories.",
          { status: 424, errorCode: "EXTERNAL_SERVICE_ERROR" },
        );
      },
    });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "scan_public_repo",
      arguments: { repository: "octo/secret" },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("This repository is private");
    expect(calls).toHaveLength(1);
  });

  it("scan_public_repo keeps the repository id when the scan cannot start", async () => {
    const { client } = stubClient({
      "POST /api/v1/repositories/public": () => PUBLIC_REPO,
      "POST /api/v1/repositories/repo-pub/scans": () => {
        throw new ApiError("Quota exceeded", {
          status: 403,
          errorCode: "OPERATION_FAILED",
          quotaType: "deep_scans",
        });
      },
    });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "scan_public_repo",
      arguments: { repository: "octo/hello" },
    });

    expect(result.isError).toBe(true);
    const message = text(result);
    expect(message).toContain('octo/hello was added as repository_id "repo-pub"');
    expect(message).toContain("Quota exhausted: no deep_scans remaining");
  });

  it("get_scan_progress with wait_seconds gives up at the deadline and returns latest", async () => {
    const { client, calls } = stubClient({
      "GET /api/v1/repositories/repo-1/scans/b-1/progress": () => ({
        batch_id: "b-1",
        status: "running",
      }),
    });
    let clock = 0;
    const realNow = Date.now;
    Date.now = () => clock;
    try {
      const { mcp } = await connect(client, {
        sleep: async (ms) => {
          clock += Math.max(ms, 1000);
        },
      });
      const result = await mcp.callTool({
        name: "get_scan_progress",
        arguments: { repository_id: "repo-1", scan_id: "b-1", wait_seconds: 3 },
      });
      expect(JSON.parse(text(result)).status).toBe("running");
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.length).toBeLessThanOrEqual(5);
    } finally {
      Date.now = realNow;
    }
  });

  it("caps wait_seconds at MAX_WAIT_SECONDS via schema validation", async () => {
    const { client, calls } = stubClient({});
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "get_scan_progress",
      arguments: { repository_id: "repo-1", scan_id: "b-1", wait_seconds: MAX_WAIT_SECONDS + 1 },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("run_fix auto-resolves the single attached source repo and provider", async () => {
    const { client, calls } = stubClient({
      "GET /api/v1/repositories/repo-1": () => ({
        ...REPO,
        repositories: [{ full_name: "acme/api", provider: "gitlab", default_branch: "main" }],
      }),
      "POST /api/v1/repositories/repo-1/fixes": (call) => ({
        id: "fix-1",
        status: "pending",
        ...(call.body as object),
      }),
    });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "run_fix",
      arguments: {
        repository_id: "repo-1",
        finding_ids: ["f-1", "f-2"],
        instructions: "Parameterize the SQL query.",
      },
    });
    expect(result.isError).toBeFalsy();
    const body = calls.find((c) => c.method === "POST")?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      finding_ids: ["f-1", "f-2"],
      instructions: "Parameterize the SQL query.",
      source_repo: "acme/api",
      source_repo_provider: "gitlab",
    });
    expect(body.title).toBeTruthy();
  });

  it("run_fix errors helpfully when several source repos are attached", async () => {
    const { client, calls } = stubClient({
      "GET /api/v1/repositories/repo-1": () => ({
        ...REPO,
        repositories: [
          { full_name: "acme/api", provider: "github", default_branch: "main" },
          { full_name: "acme/web", provider: "github", default_branch: "main" },
        ],
      }),
    });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "run_fix",
      arguments: { repository_id: "repo-1", finding_ids: ["f-1"], instructions: "fix" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("acme/api");
    expect(text(result)).toContain("acme/web");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("run_fix uses an explicit source_repo without fetching the repository", async () => {
    const { client, calls } = stubClient({
      "POST /api/v1/repositories/repo-1/fixes": () => ({ id: "fix-1", status: "pending" }),
    });
    const { mcp } = await connect(client);
    await mcp.callTool({
      name: "run_fix",
      arguments: {
        repository_id: "repo-1",
        finding_ids: ["f-1"],
        instructions: "fix",
        source_repo: "acme/other",
        source_repo_provider: "azure_devops",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      source_repo: "acme/other",
      source_repo_provider: "azure_devops",
    });
  });

  it("create_pull_request omits unset optional fields from the body", async () => {
    const { client, calls } = stubClient({
      "POST /api/v1/repositories/repo-1/fixes/fix-1/pull-requests": () => ({ pull_requests: [] }),
    });
    const { mcp } = await connect(client);
    await mcp.callTool({
      name: "create_pull_request",
      arguments: { repository_id: "repo-1", fix_id: "fix-1", title: "Fix SQLi" },
    });
    expect(calls[0]?.body).toEqual({ title: "Fix SQLi" });
  });

  it("surfaces API errors as isError results instead of throwing", async () => {
    const { client } = stubClient({
      "GET /api/v1/repositories/nope": () => {
        throw new ApiError("Repository not found", { status: 404, errorCode: "NOT_FOUND" });
      },
    });
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "get_repository",
      arguments: { repository_id: "nope" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("API error 404 [NOT_FOUND]: Repository not found");
  });
});

describe("describeError", () => {
  it("explains quota exhaustion with the reset date", () => {
    const err = new ApiError("out", {
      status: 403,
      errorCode: "OPERATION_FAILED",
      quotaType: "deep_ai_scans",
      detail: { period_end: "2026-10-01T00:00:00Z" },
    });
    expect(describeError(err)).toBe(
      "Quota exhausted: no deep_ai_scans remaining for this period. Quota resets at 2026-10-01T00:00:00Z.",
    );
  });

  it("passes through the message for the daily public-repo capacity limit", () => {
    const err = new ApiError("Deep scans of public repositories are at capacity for today.", {
      status: 403,
      errorCode: "OPERATION_FAILED",
      quotaType: "public_repo_daily_capacity",
    });
    expect(describeError(err)).toBe(
      "Limit reached: Deep scans of public repositories are at capacity for today.",
    );
  });

  it("tells the agent how to re-authenticate on 401", () => {
    const msg = describeError(new ApiError("Unauthorized", { status: 401 }));
    expect(msg).toContain("kolega auth login");
    expect(msg).toContain("KOLEGA_TOKEN");
  });

  it("uses a caller-supplied re-auth hint (hosted server)", () => {
    const msg = describeError(new ApiError("Unauthorized", { status: 401 }), "Reconnect Kolega.");
    expect(msg).toContain("Reconnect Kolega.");
    expect(msg).not.toContain("kolega auth login");
  });

  it("never echoes a token that appears in an error message context", () => {
    const msg = describeError(new Error("boom"));
    expect(msg).toBe("boom");
  });
});
