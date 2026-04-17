/**
 * Friendly aliases over the generated OpenAPI types so command code doesn't
 * have to reference the long Public*Response names everywhere.
 */
import type { components } from "./openapi-types.generated.js";

type Schemas = components["schemas"];

export type Application = Schemas["PublicApplicationResponse"];
export type ApplicationRepository = Schemas["PublicApplicationRepository"];
export type ApplicationListResponse = Schemas["PublicPaginatedResponse_PublicApplicationResponse_"];

export type ScanBatch = Schemas["PublicScanBatchResponse"];
export type ScanBatchListResponse = Schemas["PublicPaginatedResponse_PublicScanBatchResponse_"];
export type ScanProgress = Schemas["PublicScanProgressResponse"];
export type ScanProgressRepository = Schemas["PublicScanProgressRepository"];
export type ScanResults = Schemas["PublicScanResultsResponse"];
export type ScanFindingSummary = Schemas["PublicScanFindingSummary"];
export type ScanCreateRequest = Schemas["PublicScanCreateRequest"];
export type ScanType = Schemas["ScanType"];

export type Finding = Schemas["PublicFindingResponse"];
export type FindingListResponse = Schemas["PublicPaginatedResponse_PublicFindingResponse_"];
export type FindingStatusUpdateRequest = Schemas["PublicFindingStatusUpdateRequest"];
export type FindingStatus = Schemas["FindingStatus"];

export type Fix = Schemas["PublicFixResponse"];
export type FixListResponse = Schemas["PublicPaginatedResponse_PublicFixResponse_"];
export type FixProgress = Schemas["PublicFixProgressResponse"];
export type FixDiff = Schemas["PublicFixDiffResponse"];
export type FixCreateRequest = Schemas["PublicFixCreateRequest"];
export type FixPullRequestSummary = Schemas["PublicFixPullRequestSummary"];
export type CreatePullRequestsRequest = Schemas["PublicCreatePRRequest"];
export type CreatedPullRequestsResponse = Schemas["PublicPullRequestsCreatedResponse"];

export type QuotaBalance = Schemas["PublicQuotaBalanceResponse"];
export type QuotaCounter = Schemas["PublicQuotaCounter"];
export type ApplicationQuota = Schemas["PublicApplicationQuota"];

export const SCAN_TYPES: readonly ScanType[] = [
  "secrets_scan",
  "semgrep_scan",
  "deep_ai_scan",
] as const;

export const FINDING_STATUSES: readonly FindingStatus[] = [
  "open",
  "resolved",
  "ignored",
  "false_positive",
  "needs_manual_review",
] as const;

export const TERMINAL_SCAN_STATUSES: readonly string[] = [
  "completed",
  "succeeded",
  "failed",
  "partial_failure",
  "cancelled",
];

export const TERMINAL_FIX_STATUSES: readonly string[] = [
  "completed",
  "succeeded",
  "failed",
  "cancelled",
];
