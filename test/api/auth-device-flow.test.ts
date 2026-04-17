import { describe, expect, it } from "vitest";

import { ApiClient, ApiError } from "../../src/api/client.js";
import {
  DeviceFlowError,
  pollForDeviceToken,
  type TokenResponse,
} from "../../src/api/auth-device-flow.js";

type Response = TokenResponse | ApiError;

/**
 * Builds a stub ApiClient whose `postForm` method returns a queued sequence of
 * responses. Each test enqueues whatever pattern it needs and asserts on the
 * side-effects afterwards. We inject `sleep` and `now` so the polling state
 * machine runs in zero wall-clock time.
 */
function stubClient(queue: Response[]): ApiClient {
  const client = Object.create(ApiClient.prototype) as ApiClient;
  (client as unknown as { postForm: unknown }).postForm = async () => {
    if (queue.length === 0) throw new Error("unexpected extra postForm call");
    const next = queue.shift()!;
    if (next instanceof ApiError) throw next;
    return next;
  };
  return client;
}

function pendingErr(): ApiError {
  return new ApiError("User hasn't approved yet", {
    status: 400,
    errorCode: "authorization_pending",
  });
}

function slowDownErr(): ApiError {
  return new ApiError("Polling too fast", {
    status: 400,
    errorCode: "slow_down",
  });
}

function oauthErr(code: string, msg?: string): ApiError {
  return new ApiError(msg ?? code, { status: 400, errorCode: code });
}

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("pollForDeviceToken", () => {
  it("returns on a 200 with tokens", async () => {
    const client = stubClient([
      { access_token: "kcp_live_ok", token_type: "Bearer", scope: "cli" },
    ]);
    const { now } = makeClock();
    const result = await pollForDeviceToken({
      client,
      deviceCode: "dc-1",
      interval: 5,
      expiresIn: 900,
      sleep: async () => {},
      now,
    });
    expect(result.access_token).toBe("kcp_live_ok");
  });

  it("keeps polling on authorization_pending, then resolves", async () => {
    const client = stubClient([
      pendingErr(),
      pendingErr(),
      { access_token: "kcp_live_ok", token_type: "Bearer" },
    ]);
    const sleeps: number[] = [];
    const { now } = makeClock();
    const result = await pollForDeviceToken({
      client,
      deviceCode: "dc-1",
      interval: 5,
      expiresIn: 900,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now,
    });
    expect(result.access_token).toBe("kcp_live_ok");
    expect(sleeps).toEqual([5000, 5000]);
  });

  it("increases the polling interval by 5 seconds on slow_down", async () => {
    const client = stubClient([
      pendingErr(),
      slowDownErr(),
      pendingErr(),
      { access_token: "kcp_live_ok", token_type: "Bearer" },
    ]);
    const sleeps: number[] = [];
    const ticks: string[] = [];
    const { now } = makeClock();
    const result = await pollForDeviceToken({
      client,
      deviceCode: "dc-1",
      interval: 5,
      expiresIn: 900,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now,
      onTick: (s) => ticks.push(s),
    });
    expect(result.access_token).toBe("kcp_live_ok");
    // first pending → 5s wait, slow_down → +5 (interval now 10) → 10s wait, pending → 10s wait
    expect(sleeps).toEqual([5000, 10000, 10000]);
    expect(ticks).toEqual(["pending", "slow_down", "pending"]);
  });

  it("throws DeviceFlowError on access_denied", async () => {
    const client = stubClient([oauthErr("access_denied", "User rejected the pairing")]);
    await expect(
      pollForDeviceToken({
        client,
        deviceCode: "dc-1",
        interval: 5,
        expiresIn: 900,
        sleep: async () => {},
        now: () => 1_000_000,
      }),
    ).rejects.toMatchObject({
      name: "DeviceFlowError",
      reason: "access_denied",
    });
  });

  it("throws DeviceFlowError on expired_token", async () => {
    const client = stubClient([oauthErr("expired_token", "The code expired")]);
    await expect(
      pollForDeviceToken({
        client,
        deviceCode: "dc-1",
        interval: 5,
        expiresIn: 900,
        sleep: async () => {},
        now: () => 1_000_000,
      }),
    ).rejects.toMatchObject({ reason: "expired_token" });
  });

  it("throws DeviceFlowError on invalid_grant", async () => {
    const client = stubClient([oauthErr("invalid_grant")]);
    await expect(
      pollForDeviceToken({
        client,
        deviceCode: "dc-1",
        interval: 5,
        expiresIn: 900,
        sleep: async () => {},
        now: () => 1_000_000,
      }),
    ).rejects.toMatchObject({ reason: "invalid_grant" });
  });

  it("throws DeviceFlowError with unknown reason for unrecognised error codes", async () => {
    const client = stubClient([oauthErr("server_error", "backend oops")]);
    await expect(
      pollForDeviceToken({
        client,
        deviceCode: "dc-1",
        interval: 5,
        expiresIn: 900,
        sleep: async () => {},
        now: () => 1_000_000,
      }),
    ).rejects.toMatchObject({ reason: "unknown", description: "backend oops" });
  });

  it("throws expired_token if the overall deadline has passed", async () => {
    const client = stubClient([]);
    let t = 1_000_000;
    await expect(
      pollForDeviceToken({
        client,
        deviceCode: "dc-1",
        interval: 5,
        expiresIn: 1,
        sleep: async () => {},
        now: () => (t += 2000),
      }),
    ).rejects.toMatchObject({ reason: "expired_token" });
  });

  it("throws DeviceFlowError(aborted) when the signal is aborted before polling starts", async () => {
    const client = stubClient([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      pollForDeviceToken({
        client,
        deviceCode: "dc-1",
        interval: 5,
        expiresIn: 900,
        signal: controller.signal,
        sleep: async () => {},
        now: () => 1_000_000,
      }),
    ).rejects.toBeInstanceOf(DeviceFlowError);
  });
});
