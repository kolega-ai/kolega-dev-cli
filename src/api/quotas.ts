import type { ApiClient } from "./client.js";
import type { QuotaBalance } from "./types.js";

export async function getQuotaBalance(client: ApiClient): Promise<QuotaBalance> {
  return client.get<QuotaBalance>("/api/v1/quotas/balance");
}
