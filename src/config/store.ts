import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { configFilePath, resolveConfigDir } from "./paths.js";

export interface StoredConfig {
  token: string;
  baseUrl?: string;
  obtainedVia: "device_flow" | "token_flag";
  savedAt: string;
}

export type TokenSource = "env" | "file" | "none";

export interface ActiveToken {
  token: string | null;
  source: TokenSource;
  via?: StoredConfig["obtainedVia"];
  baseUrl?: string;
}

export async function readConfig(): Promise<StoredConfig | null> {
  try {
    const body = await readFile(configFilePath(), "utf8");
    const parsed = JSON.parse(body) as StoredConfig;
    if (typeof parsed.token !== "string" || !parsed.token) return null;
    return parsed;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function writeConfig(cfg: StoredConfig): Promise<void> {
  const dir = resolveConfigDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "config.json");
  const body = JSON.stringify(cfg, null, 2) + "\n";
  await writeFile(file, body, { mode: 0o600, encoding: "utf8" });
  if (process.platform !== "win32") {
    await chmod(file, 0o600);
  }
}

export async function clearConfig(): Promise<void> {
  try {
    await rm(configFilePath());
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

export async function resolveActiveToken(): Promise<ActiveToken> {
  const envToken = process.env.KOLEGA_TOKEN;
  if (envToken && envToken.length > 0) {
    return { token: envToken, source: "env" };
  }
  const stored = await readConfig();
  if (stored) {
    return {
      token: stored.token,
      source: "file",
      via: stored.obtainedVia,
      baseUrl: stored.baseUrl,
    };
  }
  return { token: null, source: "none" };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
