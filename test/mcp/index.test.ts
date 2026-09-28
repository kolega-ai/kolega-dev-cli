import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as lib from "../../src/mcp/index.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

/** Relative imports reachable from `entry`, as src-relative paths. */
function importGraph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(join(SRC, entry.replace(/\.js$/, ".ts")), "utf8");
  for (const match of source.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
    const next = join(dirname(entry), match[1]!);
    importGraph(next, seen);
  }
  return seen;
}

/** Bare package imports anywhere in the graph. */
function packageImports(files: Set<string>): Set<string> {
  const packages = new Set<string>();
  for (const file of files) {
    const source = readFileSync(join(SRC, file.replace(/\.js$/, ".ts")), "utf8");
    for (const match of source.matchAll(/from\s+"([^."][^"]*)"/g)) packages.add(match[1]!);
  }
  return packages;
}

describe("@kolegaai/cli/mcp library entry", () => {
  it("exports what the hosted server needs", () => {
    expect(typeof lib.createMcpServer).toBe("function");
    expect(typeof lib.ApiClient).toBe("function");
    expect(typeof lib.buildUserAgent).toBe("function");
    expect(lib.MCP_SERVER_NAME).toBe("kolega-devsec");
  });

  it("does not reach CLI-only code or dependencies", () => {
    const files = importGraph("mcp/index.js");
    for (const file of files) {
      expect(file).not.toMatch(/^(commands|config|ui)\//);
    }
    const packages = [...packageImports(files)];
    for (const cliOnly of ["commander", "inquirer", "ora", "chalk", "open", "cli-table3"]) {
      expect(packages).not.toContain(cliOnly);
    }
  });
});
