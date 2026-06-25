import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

import { ApiClient, buildUserAgent } from "../../src/api/client.js";
import { getMe } from "../../src/api/me.js";
import { listFindingEvents } from "../../src/api/finding-events.js";
import { cancelFix, refineFix } from "../../src/api/fixes.js";

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
    token: "kcp_live_test",
    userAgent: buildUserAgent("0.1.0"),
  });
}

describe("new public API endpoints", () => {
  it("getMe returns organization and api key identity", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/me", method: "GET" })
      .reply(200, {
        organization_id: "org-1",
        organization_name: "Acme Inc",
        organization_slug: "acme",
        api_key: { id: "key-1", name: "CI key", key_prefix: "kcp_live_abcd", scopes: ["read"] },
      });

    const me = await getMe(makeClient());
    expect(me.organization_name).toBe("Acme Inc");
    expect(me.api_key.key_prefix).toBe("kcp_live_abcd");
    expect(me.api_key.scopes).toEqual(["read"]);
  });

  it("listFindingEvents maps filters to query params and returns items", async () => {
    mockAgent
      .get(BASE)
      .intercept({
        path: "/api/v1/finding-events?repository_id=repo-1&severity=high&limit=10",
        method: "GET",
      })
      .reply(200, {
        items: [
          {
            id: "evt-1",
            organization_id: "org-1",
            repository_id: "repo-1",
            finding_id: "find-1",
            event_type: "status_changed",
            previous_status: "open",
            new_status: "resolved",
            severity: "high",
            event_timestamp: "2026-06-20T10:00:00Z",
            created_at: "2026-06-20T10:00:00Z",
          },
        ],
        total: 1,
        limit: 10,
        skip: 0,
        has_next: false,
      });

    const response = await listFindingEvents(makeClient(), {
      repositoryId: "repo-1",
      severity: "high",
      limit: 10,
    });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]!.event_type).toBe("status_changed");
  });

  it("refineFix posts instructions to the refine endpoint", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/repositories/repo-1/fixes/fix-1/refine", method: "POST" })
      .reply((req) => {
        expect(JSON.parse(String(req.body))).toEqual({ instructions: "tighten the validation" });
        return {
          statusCode: 200,
          data: JSON.stringify({
            id: "fix-1",
            repository_id: "repo-1",
            finding_ids: ["find-1"],
            title: "Autofix",
            status: "running",
            created_at: "2026-06-20T10:00:00Z",
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });

    const fix = await refineFix(makeClient(), "repo-1", "fix-1", {
      instructions: "tighten the validation",
    });
    expect(fix.id).toBe("fix-1");
    expect(fix.status).toBe("running");
  });

  it("cancelFix posts with no body and returns the cancelled fix", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/repositories/repo-1/fixes/fix-1/cancel", method: "POST" })
      .reply(200, {
        id: "fix-1",
        repository_id: "repo-1",
        finding_ids: ["find-1"],
        title: "Autofix",
        status: "cancelled",
        created_at: "2026-06-20T10:00:00Z",
      });

    const fix = await cancelFix(makeClient(), "repo-1", "fix-1");
    expect(fix.status).toBe("cancelled");
  });
});
