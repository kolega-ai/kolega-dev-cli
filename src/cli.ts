#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { registerAuthCommands } from "./commands/auth.js";
import { registerAppsCommands } from "./commands/apps.js";
import { registerScansCommands } from "./commands/scans.js";
import { registerFindingsCommands } from "./commands/findings.js";
import { registerFixesCommands } from "./commands/fixes.js";
import { registerQuotaCommand } from "./commands/quota.js";
import { handleError } from "./ui/errors.js";

async function loadVersion(): Promise<string> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "package.json");
    const raw = await readFile(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const version = await loadVersion();

  const program = new Command();
  program
    .name("kolega")
    .description("Command-line interface for the Kolega.dev public API")
    .version(version)
    .option("--api-url <url>", "override the API base URL")
    .option("--json", "emit raw JSON to stdout instead of a formatted table");

  registerAuthCommands(program, version);
  registerAppsCommands(program, version);
  registerScansCommands(program, version);
  registerFindingsCommands(program, version);
  registerFixesCommands(program, version);
  registerQuotaCommand(program, version);

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  handleError(err);
});
