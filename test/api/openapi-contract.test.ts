import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { ApiClient } from "../../src/api/client.js";
import { listFindingEvents } from "../../src/api/finding-events.js";
import { getFinding, listFindings, setFindingStatus } from "../../src/api/findings.js";
import {
  cancelFix,
  createFix,
  createFixPullRequests,
  getFix,
  getFixDiff,
  getFixProgress,
  listFixes,
  refineFix,
} from "../../src/api/fixes.js";
import { getMe } from "../../src/api/me.js";
import { getQuotaBalance } from "../../src/api/quotas.js";
import {
  addPublicRepository,
  getRepository,
  listRepositories,
} from "../../src/api/repositories.js";
import {
  getScan,
  getScanProgress,
  getScanResults,
  listScans,
  startScan,
} from "../../src/api/scans.js";

type SchemaNode = {
  $ref?: string;
  properties?: Record<string, unknown>;
  required?: string[];
};
type Operation = {
  parameters?: { name: string; in: string }[];
  requestBody?: { content: { "application/json": { schema: SchemaNode } } };
};
type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, SchemaNode> };
};

const spec = JSON.parse(readFileSync(resolve(__dirname, "../../openapi.json"), "utf8")) as Spec;

type Call = { method: string; path: string; query: string[]; body: string[] };

function recordingClient(calls: Call[]): ApiClient {
  const record =
    (method: string) =>
    (path: string, ...rest: unknown[]): Promise<unknown> => {
      const options = (method === "get" || method === "delete" ? rest[0] : rest[1]) as
        | { query?: Record<string, unknown> }
        | undefined;
      const body = method === "post" || method === "patch" ? rest[0] : undefined;
      calls.push({
        method,
        path,
        query: Object.keys(options?.query ?? {}),
        body: body && typeof body === "object" ? Object.keys(body) : [],
      });
      return Promise.resolve({ items: [], total: 0 });
    };
  return {
    get: record("get"),
    post: record("post"),
    patch: record("patch"),
    delete: record("delete"),
  } as unknown as ApiClient;
}

function findOperation(method: string, path: string): Operation | undefined {
  for (const [template, item] of Object.entries(spec.paths)) {
    const pattern = new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`);
    if (pattern.test(path)) return item[method];
  }
  return undefined;
}

function schema(name: string): SchemaNode {
  const found = spec.components.schemas[name];
  if (!found) throw new Error(`schema ${name} missing from openapi.json`);
  return found;
}

function resolveRef(node: SchemaNode): SchemaNode {
  return node.$ref ? schema(node.$ref.split("/").pop()!) : node;
}

async function everyApiCall(): Promise<Call[]> {
  const calls: Call[] = [];
  const c = recordingClient(calls);
  const r = "repo-1";
  await getMe(c);
  await getQuotaBalance(c);
  await listRepositories(c, { includeArchived: true, limit: 1, skip: 0 });
  await getRepository(c, r);
  await addPublicRepository(c, { repository: "octo/repo", branch: "main" });
  await listScans(c, r, { scanType: "semgrep_scan", status: "completed", limit: 1, skip: 0 });
  await startScan(c, r, { scan_type: "semgrep_scan" });
  await getScan(c, r, "scan-1");
  await getScanProgress(c, r, "scan-1");
  await getScanResults(c, r, "scan-1");
  await listFindings(c, r, {
    severity: "high",
    status: "open",
    scanBatchId: "scan-1",
    scanType: "sbom_scan",
    category: "license",
    limit: 1,
    skip: 0,
  });
  await getFinding(c, r, "finding-1");
  await setFindingStatus(c, r, "finding-1", "false_positive", "test fixture");
  await listFindingEvents(c, {
    repositoryId: r,
    findingId: "finding-1",
    scanType: "semgrep_scan",
    severity: "high",
    eventType: "created",
    start: "2026-01-01T00:00:00Z",
    end: "2026-02-01T00:00:00Z",
    limit: 1,
    skip: 0,
  });
  await listFixes(c, r, { findingId: "finding-1", limit: 1, skip: 0 });
  await createFix(c, r, {
    finding_ids: ["finding-1"],
    title: "Fix",
    instructions: "Patch it",
    source_repo: "octo/repo",
    source_repo_provider: "github",
    source_scan_branch: "main",
  });
  await getFix(c, r, "fix-1");
  await getFixProgress(c, r, "fix-1");
  await getFixDiff(c, r, "fix-1");
  await refineFix(c, r, "fix-1", { instructions: "keep the public API" });
  await cancelFix(c, r, "fix-1");
  await createFixPullRequests(c, r, "fix-1", { title: "Fix", body: "Body", branch_name: "fix-1" });
  return calls;
}

describe("openapi.json contract", () => {
  it("has an operation for every endpoint the CLI calls", async () => {
    const missing = (await everyApiCall())
      .filter((call) => !findOperation(call.method, call.path))
      .map((call) => `${call.method.toUpperCase()} ${call.path}`);
    expect(missing).toEqual([]);
  });

  it("accepts every query parameter the CLI sends", async () => {
    const unknown: string[] = [];
    for (const call of await everyApiCall()) {
      const accepted = new Set(
        (findOperation(call.method, call.path)?.parameters ?? [])
          .filter((p) => p.in === "query")
          .map((p) => p.name),
      );
      for (const name of call.query) {
        if (!accepted.has(name)) unknown.push(`${call.method.toUpperCase()} ${call.path} ?${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("accepts every request body field the CLI sends", async () => {
    const unknown: string[] = [];
    for (const call of await everyApiCall()) {
      if (call.body.length === 0) continue;
      const bodySchema = findOperation(call.method, call.path)?.requestBody?.content[
        "application/json"
      ].schema;
      const properties = bodySchema ? (resolveRef(bodySchema).properties ?? {}) : {};
      for (const field of call.body) {
        if (!(field in properties))
          unknown.push(`${call.method.toUpperCase()} ${call.path} ${field}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it.each([
    ["PublicRepositoryResponse", ["public_repository"]],
    ["PublicRepositoryAddRequest", ["repository", "branch"]],
    ["PublicRepositoryAddResponse", ["created", "app_url", "public_repository"]],
    [
      "PublicScanResultsResponse",
      ["assessment_complete", "status_counts", "severity_counts", "actionable_severity_counts"],
    ],
    [
      "PublicScanFindingSummary",
      ["id", "title", "status", "category", "line_start", "line_end", "manifest_paths"],
    ],
    ["PublicFindingResponse", ["line_start", "line_end", "manifest_paths"]],
    ["PublicFindingStatusUpdateRequest", ["reason"]],
    ["PublicQuotaBalanceResponse", ["public_sast_scans", "public_deep_ai_scans"]],
  ])("%s has the fields the CLI reads", (name, fields) => {
    const properties = Object.keys(schema(name).properties ?? {});
    expect(properties).toEqual(expect.arrayContaining(fields));
  });

  it("marks the fields the CLI relies on as always present", () => {
    expect(schema("PublicScanResultsResponse").required).toContain("assessment_complete");
    expect(schema("PublicScanFindingSummary").required).toEqual(
      expect.arrayContaining(["id", "status"]),
    );
    expect(schema("PublicRepositoryAddResponse").required).toEqual(
      expect.arrayContaining(["created", "app_url"]),
    );
    expect(schema("PublicQuotaBalanceResponse").required).toEqual(
      expect.arrayContaining(["public_sast_scans", "public_deep_ai_scans"]),
    );
  });
});
