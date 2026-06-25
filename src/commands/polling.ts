/**
 * Shared polling loops for `--wait` and `--watch` flags on scans and fixes.
 *
 * Two entry modes:
 * - `watch` — the user explicitly asked to tail a running operation. Ctrl+C
 *   exits with code 2 ("user interrupted") and prints "Cancelled".
 * - `wait`  — the user asked to fire-and-wait as part of a `start`/`run`
 *   command. Ctrl+C prints a friendly "still running" message and exits 0
 *   so a shell script can keep going.
 */
import chalk from "chalk";
import type { ApiClient } from "../api/client.js";
import { getScanProgress } from "../api/scans.js";
import { getFixProgress } from "../api/fixes.js";
import {
  renderFixHeartbeat,
  renderJson,
  renderScanProgress,
  type FixHeartbeatRenderState,
  type ScanProgressRenderState,
} from "../ui/render.js";
import {
  TERMINAL_FIX_STATUSES,
  TERMINAL_SCAN_STATUSES,
  type FixProgress,
  type ScanProgress,
} from "../api/types.js";
import { EXIT_INTERRUPTED } from "../ui/errors.js";

export type PollMode = "watch" | "wait";

export interface PollArgs {
  mode: PollMode;
  intervalMs: number;
  asJson: boolean;
  resumeHint: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll scan progress until a terminal status is reached. Renders in-place
 * updates on TTY, scrolling output otherwise. Returns the final progress
 * object so the caller can format a summary.
 */
export async function pollScanProgress(
  client: ApiClient,
  repositoryId: string,
  scanId: string,
  args: PollArgs,
): Promise<ScanProgress> {
  const state: ScanProgressRenderState = { lastRender: "" };
  const { cleanup, shouldExit } = installSigint(args);
  try {
    while (true) {
      const progress = await getScanProgress(client, repositoryId, scanId);
      if (args.asJson) {
        renderJson(progress);
      } else {
        renderScanProgress(progress, state);
      }
      if (TERMINAL_SCAN_STATUSES.includes(progress.status.toLowerCase())) {
        return progress;
      }
      if (shouldExit()) {
        handleInterrupted(args);
      }
      await sleepInterruptible(args.intervalMs, shouldExit);
      if (shouldExit()) {
        handleInterrupted(args);
      }
    }
  } finally {
    cleanup();
  }
}

export async function pollFixProgress(
  client: ApiClient,
  repositoryId: string,
  fixId: string,
  args: PollArgs,
): Promise<FixProgress> {
  const state: FixHeartbeatRenderState = { lastRender: "" };
  const { cleanup, shouldExit } = installSigint(args);
  try {
    while (true) {
      const progress = await getFixProgress(client, repositoryId, fixId);
      if (args.asJson) {
        renderJson(progress);
      } else {
        renderFixHeartbeat(progress, state);
      }
      if (TERMINAL_FIX_STATUSES.includes(progress.status.toLowerCase())) {
        return progress;
      }
      if (shouldExit()) {
        handleInterrupted(args);
      }
      await sleepInterruptible(args.intervalMs, shouldExit);
      if (shouldExit()) {
        handleInterrupted(args);
      }
    }
  } finally {
    cleanup();
  }
}

function installSigint(args: PollArgs): {
  shouldExit: () => boolean;
  cleanup: () => void;
} {
  let interrupted = false;
  const handler = (): void => {
    interrupted = true;
    if (args.mode === "wait") {
      process.stdout.write(
        "\n" + chalk.dim(`Still running; run \`${args.resumeHint}\` to resume watching.\n`),
      );
      process.exit(0);
    }
  };
  process.on("SIGINT", handler);
  return {
    shouldExit: () => interrupted,
    cleanup: () => process.off("SIGINT", handler),
  };
}

function handleInterrupted(args: PollArgs): never {
  if (args.mode === "wait") {
    // Already handled inside the SIGINT handler, but be defensive.
    process.exit(0);
  }
  process.stderr.write(chalk.yellow("Cancelled.\n"));
  process.exit(EXIT_INTERRUPTED);
}

async function sleepInterruptible(ms: number, shouldExit: () => boolean): Promise<void> {
  const chunk = 200;
  let remaining = ms;
  while (remaining > 0) {
    if (shouldExit()) return;
    const step = Math.min(chunk, remaining);
    await sleep(step);
    remaining -= step;
  }
}
