/**
 * RFC 8628 OAuth 2.0 Device Authorization Grant polling state machine.
 *
 * Pure / side-effect-free aside from the HTTP call itself and an injectable
 * sleep function. The command layer wraps this with a spinner and a browser
 * launch. Tests drive it with a mock HTTP client and a fake sleep to cover
 * every standard OAuth error code.
 */
import type { ApiClient } from "./client.js";
import { ApiError } from "./client.js";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer" | string;
  scope?: string;
}

export type DeviceFlowTickState = "pending" | "slow_down";

export type DeviceFlowReason =
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | "aborted"
  | "unknown";

export class DeviceFlowError extends Error {
  readonly reason: DeviceFlowReason;
  readonly description?: string;

  constructor(reason: DeviceFlowReason, description?: string) {
    super(description ?? reason);
    this.name = "DeviceFlowError";
    this.reason = reason;
    this.description = description;
  }
}

export interface PollOptions {
  client: ApiClient;
  deviceCode: string;
  interval: number;
  expiresIn: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onTick?: (state: DeviceFlowTickState) => void;
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function requestDeviceCode(
  client: ApiClient,
  clientName: string,
): Promise<DeviceCodeResponse> {
  return client.post<DeviceCodeResponse>(
    "/oauth/device/code",
    { client_name: clientName },
    { skipAuth: true },
  );
}

export async function pollForDeviceToken(opts: PollOptions): Promise<TokenResponse> {
  const {
    client,
    deviceCode,
    expiresIn,
    signal,
    sleep = defaultSleep,
    now = Date.now,
    onTick,
  } = opts;
  let interval = opts.interval;

  const deadline = now() + expiresIn * 1000;

  while (true) {
    if (signal?.aborted) {
      throw new DeviceFlowError("aborted");
    }
    if (now() >= deadline) {
      throw new DeviceFlowError(
        "expired_token",
        "Device code expired before the user approved the pairing",
      );
    }

    const form = new URLSearchParams();
    form.set("grant_type", DEVICE_GRANT);
    form.set("device_code", deviceCode);

    try {
      const token = await client.postForm<TokenResponse>("/oauth/token", form, {
        skipAuth: true,
        signal,
      });
      return token;
    } catch (err) {
      const reaction = interpretError(err);
      if (reaction.kind === "rethrow") throw err;
      if (reaction.kind === "fail") {
        throw new DeviceFlowError(reaction.reason, reaction.description);
      }
      if (reaction.kind === "slow_down") {
        interval += 5;
        onTick?.("slow_down");
      } else {
        onTick?.("pending");
      }
      await sleep(interval * 1000);
    }
  }
}

type ErrorReaction =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "fail"; reason: DeviceFlowReason; description?: string }
  | { kind: "rethrow" };

function interpretError(err: unknown): ErrorReaction {
  if (!(err instanceof ApiError)) {
    if (isAbortError(err)) {
      return { kind: "fail", reason: "aborted" };
    }
    return { kind: "rethrow" };
  }
  const code = err.errorCode;
  switch (code) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "access_denied":
      return { kind: "fail", reason: "access_denied", description: err.message };
    case "expired_token":
      return { kind: "fail", reason: "expired_token", description: err.message };
    case "invalid_grant":
      return { kind: "fail", reason: "invalid_grant", description: err.message };
    default:
      if (typeof code === "string" && code.length > 0) {
        return { kind: "fail", reason: "unknown", description: err.message };
      }
      return { kind: "rethrow" };
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: string }).name === "AbortError"
  );
}
