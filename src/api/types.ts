/**
 * Friendly aliases over the generated OpenAPI types so command code doesn't
 * have to reference the long Public*Response names everywhere.
 */
import type { components } from "./openapi-types.generated.js";

type Schemas = components["schemas"];

// `public_repository` and the add-public-repository endpoint are typed here until the
// published OpenAPI schema includes them.
export type Repository = Schemas["PublicRepositoryResponse"] & {
  /** True for a public repository added for scanning rather than the organization's own code. */
  public_repository?: boolean;
};
export type RepositoryRef = Schemas["PublicRepositoryRef"];
export type RepositoryListResponse = Omit<
  Schemas["PublicPaginatedResponse_PublicRepositoryResponse_"],
  "items"
> & { items: Repository[] };

export interface PublicRepositoryAddRequest {
  /** owner/repo or a github.com URL. */
  repository: string;
  /** Branch to scan; defaults to the repository's default branch. */
  branch?: string;
}

export type PublicRepositoryAddResponse = Repository & {
  /** False when the repository had already been added. */
  created: boolean;
  /** Web app page for this repository's scans and findings. */
  app_url: string;
};

export type Me = Schemas["PublicMeResponse"];

export type ScanBatch = Schemas["PublicScanBatchResponse"];
export type ScanBatchListResponse = Schemas["PublicPaginatedResponse_PublicScanBatchResponse_"];
export type ScanProgress = Schemas["PublicScanProgressResponse"];
export type ScanProgressRepository = Schemas["PublicScanProgressRepository"];
// Status fields typed locally so this builds against API specs that predate them.
export type ScanFindingSummary = Schemas["PublicScanFindingSummary"] & {
  id?: string;
  title?: string | null;
  status?: string;
  line_start?: number | null;
  line_end?: number | null;
};
export type ScanResults = Omit<Schemas["PublicScanResultsResponse"], "findings"> & {
  assessment_complete?: boolean;
  status_counts?: Record<string, number>;
  severity_counts?: Record<string, number>;
  actionable_severity_counts?: Record<string, number>;
  findings: ScanFindingSummary[];
};
export type ScanCreateRequest = Schemas["PublicScanCreateRequest"];
export type ScanType = Schemas["ScanType"];

export type Finding = Schemas["PublicFindingResponse"] & {
  line_start?: number | null;
  line_end?: number | null;
};
export type FindingListResponse = Schemas["PublicPaginatedResponse_PublicFindingResponse_"];
export type FindingStatusUpdateRequest = Schemas["PublicFindingStatusUpdateRequest"];
export type FindingStatus = Schemas["FindingStatus"];

export type FindingEvent = Schemas["PublicFindingEventResponse"];
export type FindingEventListResponse =
  Schemas["PublicPaginatedResponse_PublicFindingEventResponse_"];

export type Fix = Schemas["PublicFixResponse"];
export type FixListResponse = Schemas["PublicPaginatedResponse_PublicFixResponse_"];
export type FixProgress = Schemas["PublicFixProgressResponse"];
export type FixDiff = Schemas["PublicFixDiffResponse"];
export type FixCreateRequest = Schemas["PublicFixCreateRequest"];
export type FixRefineRequest = Schemas["PublicFixRefineRequest"];
export type FixPullRequestSummary = Schemas["PublicFixPullRequestSummary"];
export type CreatePullRequestsRequest = Schemas["PublicCreatePRRequest"];
export type CreatedPullRequestsResponse = Schemas["PublicPullRequestsCreatedResponse"];

export type QuotaCounter = Schemas["PublicQuotaCounter"];
/** Typed locally until the published schema has the public-repository counters. */
export type QuotaBalance = Schemas["PublicQuotaBalanceResponse"] & {
  public_sast_scans?: QuotaCounter;
  public_deep_ai_scans?: QuotaCounter;
};
export type RepositoryQuota = Schemas["PublicRepositoryQuota"];

/**
 * `quota_type` of a service-wide daily limit on public-repository deep scans. Unlike the
 * organization's own quota it doesn't reset with the billing period, so the API's message is shown.
 */
export const DAILY_CAPACITY_QUOTA_TYPE = "public_repo_daily_capacity";

export const SCAN_TYPES: readonly ScanType[] = [
  "secrets_scan",
  "semgrep_scan",
  "deep_ai_scan",
  "sbom_scan",
] as const;

export const FINDING_STATUSES: readonly FindingStatus[] = [
  "open",
  "resolved",
  "ignored",
  "false_positive",
  "needs_manual_review",
] as const;

/** Longest `reason` the API accepts with a finding status change. */
export const FINDING_STATUS_REASON_MAX_LENGTH = 1000;

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
