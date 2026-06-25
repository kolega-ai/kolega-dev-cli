import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

import { ApiClient, buildUserAgent, ApiError } from "../../src/api/client.js";
import { listRepositories, resolveDefaultRepository } from "../../src/api/repositories.js";

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

describe("repositories", () => {
  it("listRepositories paginates and returns typed items", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/repositories?limit=10&skip=0", method: "GET" })
      .reply(200, {
        items: [
          {
            id: "repo-1",
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
    const response = await listRepositories(client, { limit: 10, skip: 0 });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]!.id).toBe("repo-1");
  });

  it("resolveDefaultRepository returns the sole repository when there's exactly one", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/repositories?limit=2", method: "GET" })
      .reply(200, {
        items: [
          {
            id: "repo-only",
            name: "Only repo",
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
    const repo = await resolveDefaultRepository(client);
    expect(repo.id).toBe("repo-only");
  });

  it("resolveDefaultRepository throws a friendly ApiError when multiple repositories exist", async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: "/api/v1/repositories?limit=2", method: "GET" })
      .reply(200, {
        items: [
          {
            id: "repo-1",
            name: "Repo 1",
            description: null,
            repositories: [],
            archived: false,
            created_at: "2026-04-01T00:00:00Z",
            updated_at: "2026-04-10T00:00:00Z",
          },
          {
            id: "repo-2",
            name: "Repo 2",
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
      await resolveDefaultRepository(client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).errorCode).toBe("MULTIPLE_REPOSITORIES");
  });
});
