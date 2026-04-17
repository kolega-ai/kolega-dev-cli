import type { Command } from "commander";
import chalk from "chalk";

import { resolveApplicationId } from "../api/applications.js";
import { getScan, getScanProgress, getScanResults, listScans, startScan } from "../api/scans.js";
import { getQuotaBalance } from "../api/quotas.js";
import {
  renderJson,
  renderScanBatch,
  renderScanBatchesTable,
  renderScanProgress,
  renderScanResults,
  type ScanProgressRenderState,
} from "../ui/render.js";
import { handleError } from "../ui/errors.js";
import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/client.js";
import { buildContext, type GlobalOptions } from "./context.js";
import { pollScanProgress } from "./polling.js";
import { SCAN_TYPES, type ScanType } from "../api/types.js";

interface ListOpts {
  scanType?: string;
  status?: string;
  limit?: string;
  skip?: string;
}

interface StartOpts {
  type: string;
  wait?: boolean;
  quotaCheck: boolean;
}

interface ProgressOpts {
  watch?: boolean;
  interval?: string;
}

const CLI_SCAN_TYPE_MAP: Record<string, ScanType> = {
  secrets: "secrets_scan",
  secrets_scan: "secrets_scan",
  semgrep: "semgrep_scan",
  semgrep_scan: "semgrep_scan",
  "deep-ai": "deep_ai_scan",
  deep_ai: "deep_ai_scan",
  deep_ai_scan: "deep_ai_scan",
};

const QUOTA_COUNTER_FOR_SCAN: Record<ScanType, "sast_scans" | "deep_ai_scans"> = {
  secrets_scan: "sast_scans",
  semgrep_scan: "sast_scans",
  deep_ai_scan: "deep_ai_scans",
};

export function registerScansCommands(program: Command, pkgVersion: string): void {
  const scans = program.command("scans").description("Security scan batches");

  scans
    .command("list <application-id>")
    .description("List scan batches for an application")
    .option("--scan-type <type>", "filter by scan type (secrets|semgrep|deep-ai)")
    .option("--status <status>", "filter by status")
    .option("--limit <n>", "page size", "50")
    .option("--skip <n>", "number of items to skip", "0")
    .action(async (applicationId: string, opts: ListOpts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveApplicationId(ctx.client, applicationId);
        const response = await listScans(ctx.client, resolved, {
          scanType: opts.scanType ? toScanType(opts.scanType) : undefined,
          status: opts.status,
          limit: opts.limit ? Number(opts.limit) : undefined,
          skip: opts.skip ? Number(opts.skip) : undefined,
        });
        if (globals.json) {
          renderJson(response);
          return;
        }
        renderScanBatchesTable(response.items);
      } catch (err) {
        handleError(err);
      }
    });

  scans
    .command("start <application-id>")
    .description("Trigger a security scan")
    .requiredOption("--type <type>", "scan type: secrets|semgrep|deep-ai")
    .option("--wait", "block and stream progress until the scan is terminal")
    .option("--no-quota-check", "skip the pre-flight quota check")
    .action(async (applicationId: string, opts: StartOpts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveApplicationId(ctx.client, applicationId);
        const scanType = toScanType(opts.type);

        if (opts.quotaCheck) {
          await assertQuotaAvailable(ctx.client, scanType);
        }

        const batch = await startScan(ctx.client, resolved, { scan_type: scanType });
        if (globals.json && !opts.wait) {
          renderJson(batch);
          return;
        }
        if (!globals.json) {
          process.stdout.write(
            chalk.green("Started scan ") +
              chalk.cyan(batch.batch_id) +
              chalk.dim(` (${batch.scan_type})\n`),
          );
        }
        if (!opts.wait) return;

        await pollScanProgress(ctx.client, resolved, batch.batch_id, {
          mode: "wait",
          intervalMs: 5000,
          asJson: Boolean(globals.json),
          resumeHint: `kolega scans progress ${applicationId} ${batch.batch_id}`,
        });
      } catch (err) {
        handleError(err);
      }
    });

  scans
    .command("get <application-id> <scan-id>")
    .description("Show a single scan batch")
    .action(async (applicationId: string, scanId: string, _opts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveApplicationId(ctx.client, applicationId);
        const batch = await getScan(ctx.client, resolved, scanId);
        if (globals.json) {
          renderJson(batch);
          return;
        }
        renderScanBatch(batch);
      } catch (err) {
        handleError(err);
      }
    });

  scans
    .command("progress <application-id> <scan-id>")
    .description("Show scan progress; pass --watch to tail it")
    .option("--watch", "poll until the scan reaches a terminal state")
    .option("--interval <seconds>", "poll interval when --watch is set", "5")
    .action(async (applicationId: string, scanId: string, opts: ProgressOpts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveApplicationId(ctx.client, applicationId);

        if (!opts.watch) {
          const progress = await getScanProgress(ctx.client, resolved, scanId);
          if (globals.json) {
            renderJson(progress);
          } else {
            const state: ScanProgressRenderState = { lastRender: "" };
            renderScanProgress(progress, state);
          }
          return;
        }

        const intervalMs = Math.max(1, Number(opts.interval ?? "5")) * 1000;
        await pollScanProgress(ctx.client, resolved, scanId, {
          mode: "watch",
          intervalMs,
          asJson: Boolean(globals.json),
          resumeHint: `kolega scans progress ${applicationId} ${scanId}`,
        });
      } catch (err) {
        handleError(err);
      }
    });

  scans
    .command("results <application-id> <scan-id>")
    .description("Show aggregated findings for a scan batch")
    .action(async (applicationId: string, scanId: string, _opts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveApplicationId(ctx.client, applicationId);
        const results = await getScanResults(ctx.client, resolved, scanId);
        if (globals.json) {
          renderJson(results);
          return;
        }
        renderScanResults(results);
      } catch (err) {
        handleError(err);
      }
    });
}

function toScanType(input: string): ScanType {
  const normalized = input.toLowerCase();
  const mapped = CLI_SCAN_TYPE_MAP[normalized];
  if (mapped) return mapped;
  if ((SCAN_TYPES as readonly string[]).includes(normalized)) {
    return normalized as ScanType;
  }
  throw new Error(`Unknown scan type "${input}". Expected one of: secrets, semgrep, deep-ai.`);
}

async function assertQuotaAvailable(client: ApiClient, scanType: ScanType): Promise<void> {
  const balance = await getQuotaBalance(client);
  const counter = balance[QUOTA_COUNTER_FOR_SCAN[scanType]];
  if (counter.remaining <= 0) {
    throw new ApiError(`You're out of ${QUOTA_COUNTER_FOR_SCAN[scanType]} for this period.`, {
      status: 403,
      errorCode: "OPERATION_FAILED",
      quotaType: QUOTA_COUNTER_FOR_SCAN[scanType],
      detail: { period_end: balance.period_end },
    });
  }
}
