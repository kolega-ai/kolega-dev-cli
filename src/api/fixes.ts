import type { ApiClient } from "./client.js";
import type {
  CreatePullRequestsRequest,
  CreatedPullRequestsResponse,
  Fix,
  FixCreateRequest,
  FixDiff,
  FixListResponse,
  FixProgress,
  FixRefineRequest,
} from "./types.js";

const base = (repoId: string): string => `/api/v1/repositories/${encodeURIComponent(repoId)}/fixes`;

export async function listFixes(
  client: ApiClient,
  repositoryId: string,
  opts: { findingId?: string; limit?: number; skip?: number } = {},
): Promise<FixListResponse> {
  return client.get<FixListResponse>(base(repositoryId), {
    query: {
      finding_id: opts.findingId,
      limit: opts.limit,
      skip: opts.skip,
    },
  });
}

export async function createFix(
  client: ApiClient,
  repositoryId: string,
  body: FixCreateRequest,
): Promise<Fix> {
  return client.post<Fix>(base(repositoryId), body);
}

export async function getFix(client: ApiClient, repositoryId: string, fixId: string): Promise<Fix> {
  return client.get<Fix>(`${base(repositoryId)}/${encodeURIComponent(fixId)}`);
}

export async function getFixProgress(
  client: ApiClient,
  repositoryId: string,
  fixId: string,
): Promise<FixProgress> {
  return client.get<FixProgress>(`${base(repositoryId)}/${encodeURIComponent(fixId)}/progress`);
}

export async function getFixDiff(
  client: ApiClient,
  repositoryId: string,
  fixId: string,
): Promise<FixDiff> {
  return client.get<FixDiff>(`${base(repositoryId)}/${encodeURIComponent(fixId)}/diff`);
}

export async function refineFix(
  client: ApiClient,
  repositoryId: string,
  fixId: string,
  body: FixRefineRequest,
): Promise<Fix> {
  return client.post<Fix>(`${base(repositoryId)}/${encodeURIComponent(fixId)}/refine`, body);
}

export async function cancelFix(
  client: ApiClient,
  repositoryId: string,
  fixId: string,
): Promise<Fix> {
  return client.post<Fix>(`${base(repositoryId)}/${encodeURIComponent(fixId)}/cancel`);
}

export async function createFixPullRequests(
  client: ApiClient,
  repositoryId: string,
  fixId: string,
  body: CreatePullRequestsRequest,
): Promise<CreatedPullRequestsResponse> {
  return client.post<CreatedPullRequestsResponse>(
    `${base(repositoryId)}/${encodeURIComponent(fixId)}/pull-requests`,
    body,
  );
}
