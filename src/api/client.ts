import { request } from "undici";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  userAgent: string;
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  body?: unknown;
  bodyForm?: URLSearchParams;
  signal?: AbortSignal;
  skipAuth?: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly errorCode?: string;
  readonly detail?: unknown;
  readonly quotaType?: string;

  constructor(
    message: string,
    init: {
      status: number;
      errorCode?: string;
      detail?: unknown;
      quotaType?: string;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = init.status;
    this.errorCode = init.errorCode;
    this.detail = init.detail;
    this.quotaType = init.quotaType;
  }
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.userAgent = opts.userAgent;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.send<T>("GET", path, options);
  }

  post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.send<T>("POST", path, { ...options, body });
  }

  patch<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.send<T>("PATCH", path, { ...options, body });
  }

  delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.send<T>("DELETE", path, options);
  }

  postForm<T>(path: string, form: URLSearchParams, options: RequestOptions = {}): Promise<T> {
    return this.send<T>("POST", path, { ...options, bodyForm: form });
  }

  private async send<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.userAgent,
      ...(options.headers ?? {}),
    };
    if (!options.skipAuth) {
      headers["authorization"] = `Bearer ${this.token}`;
    }

    let body: string | undefined;
    if (options.bodyForm !== undefined) {
      body = options.bodyForm.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }

    const signal = options.signal ?? AbortSignal.timeout(this.timeoutMs);
    const res = await request(url, {
      method: method as "GET" | "POST" | "PATCH" | "DELETE",
      headers,
      body,
      signal,
    });

    const text = await res.body.text();
    const parsed = text.length > 0 ? safeJsonParse(text) : undefined;

    if (res.statusCode >= 200 && res.statusCode < 300) {
      return (parsed ?? undefined) as T;
    }

    throw buildApiError(res.statusCode, parsed, text);
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const joined = path.startsWith("http")
      ? path
      : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    if (!query) return joined;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      search.append(key, String(value));
    }
    const qs = search.toString();
    if (!qs) return joined;
    return `${joined}${joined.includes("?") ? "&" : "?"}${qs}`;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function buildApiError(status: number, parsed: unknown, rawText: string): ApiError {
  // Public-API error envelope: { detail: { detail: "...", error_code: "...", quota_type?: "..." } }
  if (isRecord(parsed)) {
    const detailField = parsed.detail;
    if (isRecord(detailField)) {
      const message =
        typeof detailField.detail === "string" ? detailField.detail : defaultMessage(status);
      const errorCode =
        typeof detailField.error_code === "string" ? detailField.error_code : undefined;
      const quotaType =
        typeof detailField.quota_type === "string" ? detailField.quota_type : undefined;
      return new ApiError(message, {
        status,
        errorCode,
        detail: detailField,
        quotaType,
      });
    }
    if (typeof detailField === "string") {
      return new ApiError(detailField, { status, detail: detailField });
    }
    // OAuth error envelope: { error: "...", error_description: "..." }
    if (typeof parsed.error === "string") {
      const message =
        typeof parsed.error_description === "string" ? parsed.error_description : parsed.error;
      return new ApiError(message, {
        status,
        errorCode: parsed.error,
        detail: parsed,
      });
    }
  }
  return new ApiError(defaultMessage(status), {
    status,
    detail: parsed ?? rawText,
  });
}

function defaultMessage(status: number): string {
  return `Request failed with status ${status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function buildUserAgent(version: string): string {
  return `kolega-cli/${version} node/${process.versions.node} ${process.platform}`;
}
