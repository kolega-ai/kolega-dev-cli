import type { ApiClient } from "./client.js";
import type { Me } from "./types.js";

/**
 * Returns the organization and API-key identity behind the current token.
 * Backed by `GET /api/v1/me`.
 */
export async function getMe(client: ApiClient): Promise<Me> {
  return client.get<Me>("/api/v1/me");
}
