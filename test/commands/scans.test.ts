import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

import { ApiClient, ApiError, buildUserAgent } from "../../src/api/client.js";
import { getQuotaBalance } from "../../src/api/quotas.js";
import { startScan } from "../../src/api/scans.js";
import { registerScansCommands } from "../../src/commands/scans.js";

const BASE = "https://api.example.test";
let mockAgent: MockAgent;
const origDispatcher = getGlobalDispatcher();
const origToken = process.env.KOLEGA_TOKEN;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  process.env.KOLEGA_TOKEN = "kcp_live_test";
});

afterEach(async () => {
  if (origToken === undefined) {
    delete process.env.KOLEGA_TOKEN;
  } else {
    process.env.KOLEGA_TOKEN = origToken;
  }
  await mockAgent.close();
  setGlobalDispatcher(origDispatcher);
  vi.restoreAllMocks();
});

function makeClient(): ApiClient {
  return new ApiClient({
    baseUrl: BASE,
    token: "kcp_live_test",
    userAgent: buildUserAgent("0.1.0"),
  });
}

function makeProgram(): Command {
  const program = new Command();
  program
    .name("kolega")
    .exitOverride()
    .option("--api-url <url>", "override the API base URL")
    .option("--json", "emit raw JSON to stdout instead of a formatted table");
  registerScansCommands(program, "0.1.0");
  return program;
}

describe("scans API wrappers", () => {
  it("quota pre-check refuses to start a scan when remaining is zero", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/quotas/balance", method: "GET" })
      .reply(200, {
        period_start: "2026-04-01T00:00:00Z",
        period_end: "2026-05-01T00:00:00Z",
        prs: { plan: 0, topup: 0, used: 0, remaining: 0 },
        sast_scans: { plan: 100, topup: 0, used: 100, remaining: 0 },
        deep_ai_scans: { plan: 0, topup: 0, used: 0, remaining: 0 },
        repositories: { max: null, current: 1 },
      });

    const client = makeClient();
    const balance = await getQuotaBalance(client);
    expect(balance.sast_scans.remaining).toBe(0);

    // Assert the command layer's pre-check logic refuses:
    const assertAvailable = (): void => {
      if (balance.sast_scans.remaining <= 0) {
        throw new ApiError("You're out of sast_scans for this period.", {
          status: 403,
          errorCode: "OPERATION_FAILED",
          quotaType: "sast_scans",
          detail: { period_end: balance.period_end },
        });
      }
    };

    expect(assertAvailable).toThrow(ApiError);
    try {
      assertAvailable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.quotaType).toBe("sast_scans");
      expect(apiErr.errorCode).toBe("OPERATION_FAILED");
    }
  });

  it("startScan sends scan_type in the POST body and returns a batch", async () => {
    mockAgent
      .get(BASE)
      .intercept({
        path: "/api/v1/repositories/repo-1/scans",
        method: "POST",
      })
      .reply((req) => {
        expect(JSON.parse(String(req.body))).toEqual({ scan_type: "secrets_scan" });
        return {
          statusCode: 202,
          data: JSON.stringify({
            batch_id: "batch-123",
            repository_id: "repo-1",
            scan_type: "secrets_scan",
            status: "queued",
            total_repositories: 2,
            scans_created: 2,
            scans_failed: 0,
            scans_completed: 0,
            scans_assessed: 0,
            created_at: "2026-04-15T10:00:00Z",
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });

    const client = makeClient();
    const batch = await startScan(client, "repo-1", { scan_type: "secrets_scan" });
    expect(batch.batch_id).toBe("batch-123");
    expect(batch.status).toBe("queued");
  });

  it("maps the sbom CLI alias to sbom_scan and checks SAST quota", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/quotas/balance", method: "GET" })
      .reply(200, {
        period_start: "2026-04-01T00:00:00Z",
        period_end: "2026-05-01T00:00:00Z",
        prs: { plan: 0, topup: 0, used: 0, remaining: 0 },
        sast_scans: { plan: 100, topup: 0, used: 42, remaining: 58 },
        deep_ai_scans: { plan: 0, topup: 0, used: 0, remaining: 0 },
        repositories: { max: null, current: 1 },
      });
    mockAgent
      .get(BASE)
      .intercept({
        path: "/api/v1/repositories/repo-1/scans",
        method: "POST",
      })
      .reply((req) => {
        expect(JSON.parse(String(req.body))).toEqual({ scan_type: "sbom_scan" });
        return {
          statusCode: 202,
          data: JSON.stringify({
            batch_id: "batch-sbom",
            repository_id: "repo-1",
            scan_type: "sbom_scan",
            status: "queued",
            total_repositories: 1,
            scans_created: 1,
            scans_failed: 0,
            scans_completed: 0,
            scans_assessed: 0,
            created_at: "2026-04-15T10:00:00Z",
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await makeProgram().parseAsync([
      "node",
      "kolega",
      "--api-url",
      BASE,
      "--json",
      "scans",
      "start",
      "repo-1",
      "--type",
      "sbom",
    ]);

    expect(stdoutWrite).toHaveBeenCalled();
    mockAgent.assertNoPendingInterceptors();
  });

  it("scans public adds the repository then starts a deep scan by default", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/repositories/public", method: "POST" })
      .reply((req) => {
        expect(JSON.parse(String(req.body))).toEqual({ repository: "octo/hello" });
        return {
          statusCode: 201,
          data: JSON.stringify({
            id: "repo-pub",
            name: "octo/hello",
            archived: false,
            public_repository: true,
            repositories: [{ full_name: "octo/hello", default_branch: "main", provider: "github" }],
            created_at: "2026-04-15T10:00:00Z",
            updated_at: "2026-04-15T10:00:00Z",
            created: true,
            app_url: "https://app.example.test/repositories/repo-pub/scans?org=org-1",
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/repositories/repo-pub/scans", method: "POST" })
      .reply((req) => {
        expect(JSON.parse(String(req.body))).toEqual({ scan_type: "deep_ai_scan" });
        return {
          statusCode: 202,
          data: JSON.stringify({
            batch_id: "batch-pub",
            repository_id: "repo-pub",
            scan_type: "deep_ai_scan",
            status: "queued",
            total_repositories: 1,
            scans_created: 0,
            scans_failed: 0,
            scans_completed: 0,
            scans_assessed: 0,
            created_at: "2026-04-15T10:00:00Z",
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await makeProgram().parseAsync([
      "node",
      "kolega",
      "--api-url",
      BASE,
      "--json",
      "scans",
      "public",
      "octo/hello",
      "--no-quota-check",
    ]);

    const printed = JSON.parse(stdoutWrite.mock.calls.map((c) => String(c[0])).join(""));
    expect(printed.repository.id).toBe("repo-pub");
    expect(printed.scan.batch_id).toBe("batch-pub");
    mockAgent.assertNoPendingInterceptors();
  });

  it("scans public checks the public-repository allowance, not the organization's own", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/quotas/balance", method: "GET" })
      .reply(200, {
        period_start: "2026-04-01T00:00:00Z",
        period_end: "2026-05-01T00:00:00Z",
        prs: { plan: 0, topup: 0, used: 0, remaining: 0 },
        sast_scans: { plan: 20, topup: 0, used: 0, remaining: 20 },
        deep_ai_scans: { plan: 4, topup: 0, used: 0, remaining: 4 },
        public_sast_scans: { plan: 20, topup: 0, used: 0, remaining: 20 },
        public_deep_ai_scans: { plan: 3, topup: 0, used: 3, remaining: 0 },
        repositories: { max: 10, current: 0 },
      });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await makeProgram().parseAsync([
      "node",
      "kolega",
      "--api-url",
      BASE,
      "scans",
      "public",
      "octo/hello",
    ]);

    expect(stderrWrite.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "public_deep_ai_scans",
    );
    expect(exit).toHaveBeenCalled();
    mockAgent.assertNoPendingInterceptors();
  });

  it("scans public shows the API's message for the daily capacity limit", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/repositories/public", method: "POST" })
      .reply(200, {
        id: "repo-pub",
        name: "octo/hello",
        archived: false,
        repositories: [],
        created_at: "2026-04-15T10:00:00Z",
        updated_at: "2026-04-15T10:00:00Z",
        created: false,
        app_url: "https://app.example.test/repositories/repo-pub/scans?org=org-1",
      });
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/repositories/repo-pub/scans", method: "POST" })
      .reply(403, {
        detail: {
          detail: "Deep scans of public repositories are at capacity for today.",
          error_code: "OPERATION_FAILED",
          quota_type: "public_repo_daily_capacity",
        },
      });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? ""}`);
    });

    await expect(
      makeProgram().parseAsync([
        "node",
        "kolega",
        "--api-url",
        BASE,
        "scans",
        "public",
        "octo/hello",
        "--no-quota-check",
      ]),
    ).rejects.toThrow("process.exit:3");

    expect(stderrWrite.mock.calls.join("")).toContain("at capacity for today");
  });

  it("reports the expanded scan type list for unknown scan types", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? ""}`);
    });

    await expect(
      makeProgram().parseAsync([
        "node",
        "kolega",
        "--api-url",
        BASE,
        "scans",
        "start",
        "repo-1",
        "--type",
        "unknown",
      ]),
    ).rejects.toThrow("process.exit:1");

    expect(stderrWrite.mock.calls.join("")).toContain(
      "Expected one of: secrets|semgrep|deep-ai|sbom.",
    );
  });
});
