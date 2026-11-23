import type { ApiClient } from "./client.js";
import { ApiError } from "./client.js";
import type {
  PublicRepositoryAddRequest,
  PublicRepositoryAddResponse,
  Repository,
  RepositoryListResponse,
} from "./types.js";

export async function listRepositories(
  client: ApiClient,
  opts: { limit?: number; skip?: number; includeArchived?: boolean } = {},
): Promise<RepositoryListResponse> {
  return client.get<RepositoryListResponse>("/api/v1/repositories", {
    query: {
      limit: opts.limit,
      skip: opts.skip,
      include_archived: opts.includeArchived,
    },
  });
}

export async function getRepository(client: ApiClient, repositoryId: string): Promise<Repository> {
  return client.get<Repository>(`/api/v1/repositories/${encodeURIComponent(repositoryId)}`);
}

/**
 * Adds any public GitHub repository so it can be scanned. Idempotent: adding
 * the same repository again returns the existing one with `created: false`.
 */
export async function addPublicRepository(
  client: ApiClient,
  body: PublicRepositoryAddRequest,
): Promise<PublicRepositoryAddResponse> {
  return client.post<PublicRepositoryAddResponse>("/api/v1/repositories/public", body);
}

/**
 * Resolves the "default" repository id.
 *
 * If the organization has exactly one non-archived repository, returns it.
 * Otherwise throws a user-facing ApiError so `handleError` can surface a
 * helpful message.
 */
export async function resolveDefaultRepository(client: ApiClient): Promise<Repository> {
  const response = await listRepositories(client, { limit: 2 });
  if (response.items.length === 0) {
    throw new ApiError(
      "No repositories exist on this organization. Create one in the web UI first.",
      { status: 404, errorCode: "NO_REPOSITORIES" },
    );
  }
  if (response.items.length > 1 || response.total > 1) {
    throw new ApiError(
      "You have multiple repositories — specify one with <repository-id> or run `kolega repos list`.",
      { status: 400, errorCode: "MULTIPLE_REPOSITORIES" },
    );
  }
  return response.items[0]!;
}

export async function resolveRepositoryId(client: ApiClient, input: string): Promise<string> {
  if (input !== "default") return input;
  const repo = await resolveDefaultRepository(client);
  return repo.id;
}
