import type { ApiClient } from "./client.js";
import { ApiError } from "./client.js";
import type { Application, ApplicationListResponse } from "./types.js";

export async function listApplications(
  client: ApiClient,
  opts: { limit?: number; skip?: number; includeArchived?: boolean } = {},
): Promise<ApplicationListResponse> {
  return client.get<ApplicationListResponse>("/api/v1/applications", {
    query: {
      limit: opts.limit,
      skip: opts.skip,
      include_archived: opts.includeArchived,
    },
  });
}

export async function getApplication(
  client: ApiClient,
  applicationId: string,
): Promise<Application> {
  return client.get<Application>(`/api/v1/applications/${encodeURIComponent(applicationId)}`);
}

/**
 * Resolves the "default" application id.
 *
 * If the organization has exactly one non-archived application, returns it.
 * Otherwise throws a user-facing ApiError so `handleError` can surface a
 * helpful message.
 */
export async function resolveDefaultApplication(client: ApiClient): Promise<Application> {
  const response = await listApplications(client, { limit: 2 });
  if (response.items.length === 0) {
    throw new ApiError(
      "No applications exist on this organization. Create one in the web UI first.",
      { status: 404, errorCode: "NO_APPLICATIONS" },
    );
  }
  if (response.items.length > 1 || response.total > 1) {
    throw new ApiError(
      "You have multiple applications — specify one with --app <id> or run `kolega apps list`.",
      { status: 400, errorCode: "MULTIPLE_APPLICATIONS" },
    );
  }
  return response.items[0]!;
}

export async function resolveApplicationId(client: ApiClient, input: string): Promise<string> {
  if (input !== "default") return input;
  const app = await resolveDefaultApplication(client);
  return app.id;
}
