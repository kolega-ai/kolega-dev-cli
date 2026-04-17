import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

import { ApiClient, buildUserAgent, ApiError } from "../../src/api/client.js";
import { listApplications, resolveDefaultApplication } from "../../src/api/applications.js";

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

describe("applications", () => {
  it("listApplications paginates and returns typed items", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/applications?limit=10&skip=0", method: "GET" })
      .reply(200, {
        items: [
          {
            id: "app-1",
            name: "Example",
            description: null,
            repositories: [],
            archived: false,
            created_at: "2026-04-01T00:00:00Z",
            updated_at: "2026-04-10T00:00:00Z",
          },
        ],
        total: 1,
        limit: 10,
        skip: 0,
        has_next: false,
      });

    const client = makeClient();
    const response = await listApplications(client, { limit: 10, skip: 0 });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]!.id).toBe("app-1");
  });

  it("resolveDefaultApplication returns the sole application when there's exactly one", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/applications?limit=2", method: "GET" })
      .reply(200, {
        items: [
          {
            id: "app-only",
            name: "Only app",
            description: null,
            repositories: [],
            archived: false,
            created_at: "2026-04-01T00:00:00Z",
            updated_at: "2026-04-10T00:00:00Z",
          },
        ],
        total: 1,
        limit: 2,
        skip: 0,
        has_next: false,
      });

    const client = makeClient();
    const app = await resolveDefaultApplication(client);
    expect(app.id).toBe("app-only");
  });

  it("resolveDefaultApplication throws a friendly ApiError when multiple apps exist", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/applications?limit=2", method: "GET" })
      .reply(200, {
        items: [
          {
            id: "app-1",
            name: "App 1",
            description: null,
            repositories: [],
            archived: false,
            created_at: "2026-04-01T00:00:00Z",
            updated_at: "2026-04-10T00:00:00Z",
          },
          {
            id: "app-2",
            name: "App 2",
            description: null,
            repositories: [],
            archived: false,
            created_at: "2026-04-01T00:00:00Z",
            updated_at: "2026-04-10T00:00:00Z",
          },
        ],
        total: 2,
        limit: 2,
        skip: 0,
        has_next: false,
      });

    const client = makeClient();
    let caught: unknown;
    try {
      await resolveDefaultApplication(client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).errorCode).toBe("MULTIPLE_APPLICATIONS");
  });
});
