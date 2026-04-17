import type { ApiClient } from "./client.js";
import type {
  CreatePullRequestsRequest,
  CreatedPullRequestsResponse,
  Fix,
  FixCreateRequest,
  FixDiff,
  FixListResponse,
  FixProgress,
} from "./types.js";

const base = (appId: string): string => `/api/v1/applications/${encodeURIComponent(appId)}/fixes`;

export async function listFixes(
  client: ApiClient,
  applicationId: string,
  opts: { findingId?: string; limit?: number; skip?: number } = {},
): Promise<FixListResponse> {
  return client.get<FixListResponse>(base(applicationId), {
    query: {
      finding_id: opts.findingId,
      limit: opts.limit,
      skip: opts.skip,
    },
  });
}

export async function createFix(
  client: ApiClient,
  applicationId: string,
  body: FixCreateRequest,
): Promise<Fix> {
  return client.post<Fix>(base(applicationId), body);
}

export async function getFix(
  client: ApiClient,
  applicationId: string,
  fixId: string,
): Promise<Fix> {
  return client.get<Fix>(`${base(applicationId)}/${encodeURIComponent(fixId)}`);
}

export async function getFixProgress(
  client: ApiClient,
  applicationId: string,
  fixId: string,
): Promise<FixProgress> {
  return client.get<FixProgress>(`${base(applicationId)}/${encodeURIComponent(fixId)}/progress`);
}

export async function getFixDiff(
  client: ApiClient,
  applicationId: string,
  fixId: string,
): Promise<FixDiff> {
  return client.get<FixDiff>(`${base(applicationId)}/${encodeURIComponent(fixId)}/diff`);
}

export async function createFixPullRequests(
  client: ApiClient,
  applicationId: string,
  fixId: string,
  body: CreatePullRequestsRequest,
): Promise<CreatedPullRequestsResponse> {
  return client.post<CreatedPullRequestsResponse>(
    `${base(applicationId)}/${encodeURIComponent(fixId)}/pull-requests`,
    body,
  );
}
