import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { configFilePath } from "../../src/config/paths.js";
import {
  readConfig,
  writeConfig,
  clearConfig,
  resolveActiveToken,
  type StoredConfig,
} from "../../src/config/store.js";

let tempDir: string;
const origXdg = process.env.XDG_CONFIG_HOME;
const origAppData = process.env.APPDATA;
const origToken = process.env.KOLEGA_TOKEN;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "kolega-cfg-"));
  if (process.platform === "win32") {
    process.env.APPDATA = tempDir;
  } else {
    process.env.XDG_CONFIG_HOME = tempDir;
  }
  delete process.env.KOLEGA_TOKEN;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  if (origAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = origAppData;
  if (origToken === undefined) delete process.env.KOLEGA_TOKEN;
  else process.env.KOLEGA_TOKEN = origToken;
});

describe("config store", () => {
  it("round-trips a stored config", async () => {
    const cfg: StoredConfig = {
      token: "kcp_live_test_abc12",
      baseUrl: "https://api.kolegatestapps.com",
      obtainedVia: "device_flow",
      savedAt: "2026-04-15T10:00:00.000Z",
    };
    await writeConfig(cfg);
    const read = await readConfig();
    expect(read).toEqual(cfg);
  });

  it("writes the config file with 0600 permissions", async () => {
    if (process.platform === "win32") return;
    await writeConfig({
      token: "kcp_live_secret",
      obtainedVia: "token_flag",
      savedAt: new Date().toISOString(),
    });
    const st = await stat(configFilePath());
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("returns null when config does not exist", async () => {
    expect(await readConfig()).toBeNull();
  });

  it("clearConfig removes the file and is idempotent", async () => {
    await writeConfig({
      token: "kcp_live_x",
      obtainedVia: "device_flow",
      savedAt: new Date().toISOString(),
    });
    await clearConfig();
    expect(await readConfig()).toBeNull();
    await clearConfig();
  });

  it("resolveActiveToken prefers KOLEGA_TOKEN env var over stored file", async () => {
    await writeConfig({
      token: "kcp_live_from_file",
      obtainedVia: "device_flow",
      savedAt: new Date().toISOString(),
    });
    process.env.KOLEGA_TOKEN = "kcp_live_from_env";
    const active = await resolveActiveToken();
    expect(active.token).toBe("kcp_live_from_env");
    expect(active.source).toBe("env");
  });

  it("resolveActiveToken falls back to file when env var unset", async () => {
    await writeConfig({
      token: "kcp_live_from_file",
      obtainedVia: "device_flow",
      savedAt: new Date().toISOString(),
    });
    const active = await resolveActiveToken();
    expect(active.token).toBe("kcp_live_from_file");
    expect(active.source).toBe("file");
    expect(active.via).toBe("device_flow");
  });

  it("resolveActiveToken returns none when no token available", async () => {
    const active = await resolveActiveToken();
    expect(active.token).toBeNull();
    expect(active.source).toBe("none");
  });

  it("does not leak the token into the config file body beyond its own field", async () => {
    const cfg: StoredConfig = {
      token: "kcp_live_top_secret",
      obtainedVia: "device_flow",
      savedAt: new Date().toISOString(),
    };
    await writeConfig(cfg);
    const body = await readFile(configFilePath(), "utf8");
    const parsed = JSON.parse(body);
    expect(parsed.token).toBe(cfg.token);
  });
});
