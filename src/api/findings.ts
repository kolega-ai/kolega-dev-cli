import type { ApiClient } from "./client.js";
import type {
  Finding,
  FindingListResponse,
  FindingStatus,
  FindingStatusUpdateRequest,
} from "./types.js";

const base = (repoId: string): string =>
  `/api/v1/repositories/${encodeURIComponent(repoId)}/findings`;

export async function listFindings(
  client: ApiClient,
  repositoryId: string,
  opts: {
    severity?: string;
    status?: string;
    scanBatchId?: string;
    scanType?: string;
    category?: string;
    limit?: number;
    skip?: number;
  } = {},
): Promise<FindingListResponse> {
  return client.get<FindingListResponse>(base(repositoryId), {
    query: {
      severity: opts.severity,
      status: opts.status,
      scan_batch_id: opts.scanBatchId,
      scan_type: opts.scanType,
      category: opts.category,
      limit: opts.limit,
      skip: opts.skip,
    },
  });
}

export async function getFinding(
  client: ApiClient,
  repositoryId: string,
  findingId: string,
): Promise<Finding> {
  return client.get<Finding>(`${base(repositoryId)}/${encodeURIComponent(findingId)}`);
}

export async function setFindingStatus(
  client: ApiClient,
  repositoryId: string,
  findingId: string,
  status: FindingStatus,
  reason?: string,
): Promise<Finding> {
  // Organizations can require a reason to close a finding (resolved, ignored, false_positive).
  const body: FindingStatusUpdateRequest = reason ? { status, reason } : { status };
  return client.patch<Finding>(`${base(repositoryId)}/${encodeURIComponent(findingId)}`, body);
}
