import type { ApiClient } from "./client.js";
import type {
  ScanBatch,
  ScanBatchListResponse,
  ScanCreateRequest,
  ScanProgress,
  ScanResults,
  ScanType,
} from "./types.js";

const base = (repoId: string): string => `/api/v1/repositories/${encodeURIComponent(repoId)}/scans`;

export async function listScans(
  client: ApiClient,
  repositoryId: string,
  opts: { scanType?: ScanType; status?: string; limit?: number; skip?: number } = {},
): Promise<ScanBatchListResponse> {
  return client.get<ScanBatchListResponse>(base(repositoryId), {
    query: {
      scan_type: opts.scanType,
      status: opts.status,
      limit: opts.limit,
      skip: opts.skip,
    },
  });
}

export async function startScan(
  client: ApiClient,
  repositoryId: string,
  body: ScanCreateRequest,
): Promise<ScanBatch> {
  return client.post<ScanBatch>(base(repositoryId), body);
}

export async function getScan(
  client: ApiClient,
  repositoryId: string,
  scanId: string,
): Promise<ScanBatch> {
  return client.get<ScanBatch>(`${base(repositoryId)}/${encodeURIComponent(scanId)}`);
}

export async function getScanProgress(
  client: ApiClient,
  repositoryId: string,
  scanId: string,
): Promise<ScanProgress> {
  return client.get<ScanProgress>(`${base(repositoryId)}/${encodeURIComponent(scanId)}/progress`);
}

export async function getScanResults(
  client: ApiClient,
  repositoryId: string,
  scanId: string,
): Promise<ScanResults> {
  return client.get<ScanResults>(`${base(repositoryId)}/${encodeURIComponent(scanId)}/results`);
}
