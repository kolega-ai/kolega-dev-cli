import { homedir } from "node:os";
import path from "node:path";

export function resolveConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) {
      throw new Error("APPDATA environment variable is not set");
    }
    return path.join(appData, "kolega");
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
  return path.join(base, "kolega");
}

export function configFilePath(): string {
  return path.join(resolveConfigDir(), "config.json");
}
