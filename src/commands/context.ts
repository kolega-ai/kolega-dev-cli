import { ApiClient, buildUserAgent } from "../api/client.js";
import { resolveActiveToken } from "../config/store.js";
import { NotAuthenticatedError } from "../ui/errors.js";

export const DEFAULT_API_URL = "https://api.kolega.dev";

export interface GlobalOptions {
  apiUrl?: string;
  json?: boolean;
}

export interface Context {
  client: ApiClient;
  baseUrl: string;
  tokenSource: "env" | "file";
}

export async function buildContext(globals: GlobalOptions, pkgVersion: string): Promise<Context> {
  const active = await resolveActiveToken();
  if (!active.token) throw new NotAuthenticatedError();
  const baseUrl = globals.apiUrl ?? process.env.KOLEGA_API_URL ?? active.baseUrl ?? DEFAULT_API_URL;
  const client = new ApiClient({
    baseUrl,
    token: active.token,
    userAgent: buildUserAgent(pkgVersion),
  });
  return { client, baseUrl, tokenSource: active.source as "env" | "file" };
}

export function buildAnonymousClient(globals: GlobalOptions, pkgVersion: string): ApiClient {
  const baseUrl = globals.apiUrl ?? process.env.KOLEGA_API_URL ?? DEFAULT_API_URL;
  return new ApiClient({
    baseUrl,
    token: "",
    userAgent: buildUserAgent(pkgVersion),
  });
}

export function resolveBaseUrl(globals: GlobalOptions, storedBaseUrl?: string): string {
  return globals.apiUrl ?? process.env.KOLEGA_API_URL ?? storedBaseUrl ?? DEFAULT_API_URL;
}
