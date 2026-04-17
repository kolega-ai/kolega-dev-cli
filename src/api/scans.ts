import type { ApiClient } from "./client.js";
import type {
  ScanBatch,
  ScanBatchListResponse,
  ScanCreateRequest,
  ScanProgress,
  ScanResults,
  ScanType,
} from "./types.js";

const base = (appId: string): string => `/api/v1/applications/${encodeURIComponent(appId)}/scans`;

export async function listScans(
  client: ApiClient,
  applicationId: string,
  opts: { scanType?: ScanType; status?: string; limit?: number; skip?: number } = {},
): Promise<ScanBatchListResponse> {
  return client.get<ScanBatchListResponse>(base(applicationId), {
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
  applicationId: string,
  body: ScanCreateRequest,
): Promise<ScanBatch> {
  return client.post<ScanBatch>(base(applicationId), body);
}

export async function getScan(
  client: ApiClient,
  applicationId: string,
  scanId: string,
): Promise<ScanBatch> {
  return client.get<ScanBatch>(`${base(applicationId)}/${encodeURIComponent(scanId)}`);
}

export async function getScanProgress(
  client: ApiClient,
  applicationId: string,
  scanId: string,
): Promise<ScanProgress> {
  return client.get<ScanProgress>(`${base(applicationId)}/${encodeURIComponent(scanId)}/progress`);
}

export async function getScanResults(
  client: ApiClient,
  applicationId: string,
  scanId: string,
): Promise<ScanResults> {
  return client.get<ScanResults>(`${base(applicationId)}/${encodeURIComponent(scanId)}/results`);
}
