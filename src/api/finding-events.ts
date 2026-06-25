import type { ApiClient } from "./client.js";
import type { FindingEventListResponse } from "./types.js";

/**
 * Lists finding lifecycle events (the audit trail) for the organization.
 *
 * Backed by the top-level `GET /api/v1/finding-events` endpoint — the
 * repository is an optional filter (`repositoryId`), not a path segment.
 * Events are returned newest-first, which makes the endpoint suitable for
 * polling.
 */
export async function listFindingEvents(
  client: ApiClient,
  opts: {
    repositoryId?: string;
    findingId?: string;
    scanType?: string;
    severity?: string;
    eventType?: string;
    start?: string;
    end?: string;
    limit?: number;
    skip?: number;
  } = {},
): Promise<FindingEventListResponse> {
  return client.get<FindingEventListResponse>("/api/v1/finding-events", {
    query: {
      repository_id: opts.repositoryId,
      finding_id: opts.findingId,
      scan_type: opts.scanType,
      severity: opts.severity,
      event_type: opts.eventType,
      start: opts.start,
      end: opts.end,
      limit: opts.limit,
      skip: opts.skip,
    },
  });
}
