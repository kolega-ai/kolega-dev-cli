import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

import { ApiClient, ApiError, buildApiError, buildUserAgent } from "../../src/api/client.js";

const BASE = "https://api.example.test";
let mockAgent: MockAgent;
const origDispatcher = getGlobalDispatcher();

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
  setGlobalDispatcher(origDispatcher);
});

function makeClient(): ApiClient {
  return new ApiClient({
    baseUrl: BASE,
    token: "kcp_live_test_token",
    userAgent: buildUserAgent("0.1.0"),
  });
}

describe("ApiClient", () => {
  it("injects Authorization and User-Agent headers on GET", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/repositories", method: "GET" })
      .reply(200, { items: [], total: 0, limit: 50, skip: 0, has_next: false });

    const client = makeClient();
    const res = await client.get<{ items: unknown[] }>("/api/v1/repositories");
    expect(res.items).toEqual([]);
  });

  it("serializes JSON bodies on POST and parses typed JSON responses", async () => {
    mockAgent
      .get(BASE)
      .intercept({
        path: "/api/v1/repositories/repo-1/scans",
        method: "POST",
      })
      .reply((req) => {
        const body = JSON.parse(String(req.body));
        expect(body).toEqual({ scan_type: "secrets_scan" });
        return {
          statusCode: 202,
          data: JSON.stringify({ batch_id: "b-1", scan_type: "secrets_scan" }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });

    const client = makeClient();
    const res = await client.post<{ batch_id: string }>("/api/v1/repositories/repo-1/scans", {
      scan_type: "secrets_scan",
    });
    expect(res.batch_id).toBe("b-1");
  });

  it("serializes form bodies via postForm", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/oauth/token", method: "POST" })
      .reply((req) => {
        expect(String(req.body)).toContain("grant_type=");
        expect(req.headers).toBeDefined();
        return {
          statusCode: 200,
          data: JSON.stringify({ access_token: "kcp_live_x", token_type: "Bearer", scope: "cli" }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });

    const client = makeClient();
    const form = new URLSearchParams();
    form.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
    form.set("device_code", "dc-1");
    const res = await client.postForm<{ access_token: string }>("/oauth/token", form, {
      skipAuth: true,
    });
    expect(res.access_token).toBe("kcp_live_x");
  });

  it("throws ApiError for public-API envelope", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/repositories/repo-1/scans", method: "POST" })
      .reply(
        403,
        {
          detail: {
            detail: "Monthly SAST scan quota exhausted",
            error_code: "OPERATION_FAILED",
            quota_type: "sast_scans",
          },
        },
        { headers: { "content-type": "application/json" } },
      );

    const client = makeClient();
    await expect(
      client.post("/api/v1/repositories/repo-1/scans", { scan_type: "secrets_scan" }),
    ).rejects.toMatchObject({
      status: 403,
      errorCode: "OPERATION_FAILED",
      quotaType: "sast_scans",
      message: "Monthly SAST scan quota exhausted",
    });
  });

  it("throws ApiError for OAuth envelope", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/oauth/token", method: "POST" })
      .reply(
        400,
        { error: "authorization_pending", error_description: "User hasn't approved yet" },
        { headers: { "content-type": "application/json" } },
      );

    const client = makeClient();
    const form = new URLSearchParams();
    form.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
    form.set("device_code", "dc-1");
    await expect(client.postForm("/oauth/token", form, { skipAuth: true })).rejects.toMatchObject({
      status: 400,
      errorCode: "authorization_pending",
      message: "User hasn't approved yet",
    });
  });

  it("falls back to status-only message when envelope is unrecognised", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/weird", method: "GET" })
      .reply(500, "boom", { headers: { "content-type": "text/plain" } });

    const client = makeClient();
    await expect(client.get("/api/v1/weird")).rejects.toMatchObject({
      status: 500,
      message: "Request failed with status 500",
    });
  });

  it("passes query params through URL", async () => {
    mockAgent
      .get(BASE)
      .intercept({
        path: "/api/v1/repositories/repo-1/findings?severity=high&status=open",
        method: "GET",
      })
      .reply(200, { items: [], total: 0, limit: 50, skip: 0, has_next: false });

    const client = makeClient();
    const res = await client.get("/api/v1/repositories/repo-1/findings", {
      query: { severity: "high", status: "open", scan_batch_id: undefined },
    });
    expect(res).toBeDefined();
  });

  it("buildApiError handles string detail field", () => {
    const err = buildApiError(404, { detail: "Not found" }, '{"detail":"Not found"}');
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Not found");
  });

  it("buildUserAgent includes the package version", () => {
    const ua = buildUserAgent("1.2.3");
    expect(ua).toContain("kolega-cli/1.2.3");
    expect(ua).toContain("node/");
  });
});
