/**
 * Fetch the live OpenAPI spec from the Kolega API, cache it to ./openapi.json,
 * then run `openapi-typescript` against the cached file to produce
 * src/api/openapi-types.generated.ts.
 *
 * Run with: npm run generate-types
 * Override the backend with KOLEGA_API_URL=https://api.kolegatestapps.com npm run generate-types
 */
import { request } from "undici";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_BASE = "https://api.kolega.dev";

async function fetchSpec(baseUrl: string): Promise<unknown> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/openapi.json`;
  console.log(`Fetching OpenAPI spec from ${url}`);
  const res = await request(url, { method: "GET" });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Failed to fetch spec: HTTP ${res.statusCode}`);
  }
  return res.body.json();
}

function runOpenapiTypescript(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npx", ["openapi-typescript", inputPath, "-o", outputPath], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`openapi-typescript exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const baseUrl = process.env.KOLEGA_API_URL ?? DEFAULT_BASE;
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);
  const specPath = resolve(repoRoot, "openapi.json");
  const typesPath = resolve(repoRoot, "src/api/openapi-types.generated.ts");

  const spec = await fetchSpec(baseUrl);
  await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n", "utf8");
  console.log(`Wrote ${specPath}`);

  await runOpenapiTypescript(specPath, typesPath);
  console.log(`Wrote ${typesPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
