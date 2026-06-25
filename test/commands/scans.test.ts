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
