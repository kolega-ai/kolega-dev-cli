import chalk from "chalk";
import { ApiError } from "../api/client.js";
import { DeviceFlowError } from "../api/auth-device-flow.js";

export const EXIT_OK = 0;
export const EXIT_GENERIC = 1;
export const EXIT_INTERRUPTED = 2;
export const EXIT_QUOTA_EXHAUSTED = 3;
export const EXIT_NOT_AUTHENTICATED = 4;
export const EXIT_API_ERROR = 5;

/**
 * Central error → exit code mapper. Every command's top-level catch routes
 * through here so that error messages and exit codes stay consistent.
 *
 * NOTE: never include the token in the printed message. Tokens are only
 * stored in-process and in the 0600 config file; they must never leak to
 * stderr or stdout.
 */
export function handleError(err: unknown): never {
  if (err instanceof ApiError) return handleApiError(err);
  if (err instanceof DeviceFlowError) return handleDeviceFlowError(err);
  if (isAbortError(err)) {
    process.stderr.write(chalk.yellow("Cancelled.\n"));
    process.exit(EXIT_INTERRUPTED);
  }
  if (err instanceof NotAuthenticatedError) {
    process.stderr.write(
      chalk.red("Not authenticated.") +
        " Run " +
        chalk.cyan("kolega auth login") +
        " or set " +
        chalk.cyan("KOLEGA_TOKEN") +
        ".\n",
    );
    process.exit(EXIT_NOT_AUTHENTICATED);
  }
  if (err instanceof Error) {
    process.stderr.write(chalk.red("Error: ") + err.message + "\n");
    process.exit(EXIT_GENERIC);
  }
  process.stderr.write(chalk.red("Error: ") + String(err) + "\n");
  process.exit(EXIT_GENERIC);
}

function handleApiError(err: ApiError): never {
  if (err.errorCode === "OPERATION_FAILED" && err.quotaType) {
    const periodEnd = extractPeriodEnd(err.detail);
    const when = periodEnd ? ` Period resets on ${periodEnd}.` : "";
    process.stderr.write(chalk.red(`You're out of ${err.quotaType} for this period.${when}\n`));
    process.exit(EXIT_QUOTA_EXHAUSTED);
  }
  if (err.status === 401 || (err.status === 403 && !err.quotaType)) {
    process.stderr.write(
      chalk.red("Not authenticated or token does not have access: ") +
        err.message +
        "\n" +
        chalk.dim("Run `kolega auth login` to re-authenticate.\n"),
    );
    process.exit(EXIT_NOT_AUTHENTICATED);
  }
  if (err.errorCode === "MULTIPLE_REPOSITORIES" || err.errorCode === "NO_REPOSITORIES") {
    process.stderr.write(chalk.red(err.message) + "\n");
    process.exit(EXIT_GENERIC);
  }
  process.stderr.write(chalk.red(`API error (${err.status}): `) + err.message + "\n");
  process.exit(EXIT_API_ERROR);
}

function handleDeviceFlowError(err: DeviceFlowError): never {
  let exitCode = EXIT_GENERIC;
  switch (err.reason) {
    case "access_denied":
      process.stderr.write(
        chalk.red("You denied the pairing.") +
          " Run " +
          chalk.cyan("kolega auth login") +
          " to try again.\n",
      );
      break;
    case "expired_token":
    case "invalid_grant":
      process.stderr.write(
        chalk.red("The code expired.") +
          " Run " +
          chalk.cyan("kolega auth login") +
          " to start over.\n",
      );
      break;
    case "aborted":
      process.stderr.write(chalk.yellow("Cancelled.\n"));
      exitCode = EXIT_INTERRUPTED;
      break;
    default:
      process.stderr.write(
        chalk.red("Device flow failed: ") + (err.description ?? err.reason) + "\n",
      );
  }
  process.exit(exitCode);
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not authenticated");
    this.name = "NotAuthenticatedError";
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    ((err as { name?: string }).name === "AbortError" ||
      (err as { name?: string }).name === "DOMException")
  );
}

function extractPeriodEnd(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null) return null;
  const rec = detail as Record<string, unknown>;
  const end = rec.period_end;
  if (typeof end === "string") return end;
  return null;
}
