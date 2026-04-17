import type { ApiClient } from "./client.js";
import type { Finding, FindingListResponse, FindingStatus } from "./types.js";

const base = (appId: string): string =>
  `/api/v1/applications/${encodeURIComponent(appId)}/findings`;

export async function listFindings(
  client: ApiClient,
  applicationId: string,
  opts: {
    severity?: string;
    status?: string;
    scanBatchId?: string;
    scanType?: string;
    limit?: number;
    skip?: number;
  } = {},
): Promise<FindingListResponse> {
  return client.get<FindingListResponse>(base(applicationId), {
    query: {
      severity: opts.severity,
      status: opts.status,
      scan_batch_id: opts.scanBatchId,
      scan_type: opts.scanType,
      limit: opts.limit,
      skip: opts.skip,
    },
  });
}

export async function getFinding(
  client: ApiClient,
  applicationId: string,
  findingId: string,
): Promise<Finding> {
  return client.get<Finding>(`${base(applicationId)}/${encodeURIComponent(findingId)}`);
}

export async function setFindingStatus(
  client: ApiClient,
  applicationId: string,
  findingId: string,
  status: FindingStatus,
): Promise<Finding> {
  return client.patch<Finding>(`${base(applicationId)}/${encodeURIComponent(findingId)}`, {
    status,
  });
}
