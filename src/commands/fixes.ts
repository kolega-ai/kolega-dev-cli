import type { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";

import { getRepository, resolveRepositoryId } from "../api/repositories.js";
import {
  cancelFix,
  createFix,
  createFixPullRequests,
  getFix,
  getFixDiff,
  getFixProgress,
  listFixes,
  refineFix,
} from "../api/fixes.js";
import { getQuotaBalance } from "../api/quotas.js";
import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/client.js";
import {
  renderFix,
  renderFixHeartbeat,
  renderFixesTable,
  renderJson,
  type FixHeartbeatRenderState,
} from "../ui/render.js";
import { handleError } from "../ui/errors.js";
import { buildContext, type GlobalOptions } from "./context.js";
import { pollFixProgress } from "./polling.js";
import type { FixCreateRequest, FixRefineRequest, RepositoryRef } from "../api/types.js";

interface ListOpts {
  findingId?: string;
  limit?: string;
  skip?: string;
}

interface RunOpts {
  findingIds: string;
  instructions?: string;
  title?: string;
  sourceRepo?: string;
  sourceRepoProvider?: string;
  sourceScanBranch?: string;
  wait?: boolean;
  quotaCheck: boolean;
}

interface ProgressOpts {
  watch?: boolean;
  interval?: string;
}

interface RefineOpts {
  instructions?: string;
  wait?: boolean;
}

interface PrOpts {
  title?: string;
  body?: string;
  branchName?: string;
}

const DEFAULT_TITLE = "Kolega CLI autofix";

export function registerFixesCommands(program: Command, pkgVersion: string): void {
  const fixes = program.command("fixes").description("AI-generated fixes and pull requests");

  fixes
    .command("list <repository-id>")
    .description("List fixes for a repository")
    .option("--finding-id <id>", "filter by finding id")
    .option("--limit <n>", "page size", "50")
    .option("--skip <n>", "number of items to skip", "0")
    .action(async (repositoryId: string, opts: ListOpts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveRepositoryId(ctx.client, repositoryId);
        const response = await listFixes(ctx.client, resolved, {
          findingId: opts.findingId,
          limit: opts.limit ? Number(opts.limit) : undefined,
          skip: opts.skip ? Number(opts.skip) : undefined,
        });
        if (globals.json) {
          renderJson(response);
          return;
        }
        renderFixesTable(response.items);
      } catch (err) {
        handleError(err);
      }
    });

  fixes
    .command("run <repository-id>")
    .description("Trigger an autofix run for one or more findings")
    .requiredOption("--finding-ids <ids>", "comma-separated finding ids")
    .option("--instructions <text>", "fix instructions (prompts if omitted)")
    .option("--title <text>", "fix title")
    .option("--source-repo <owner/repo>", "source repository full name")
    .option("--source-repo-provider <provider>", "github|gitlab|azure_devops", "github")
    .option("--source-scan-branch <branch>", "branch the finding was detected on")
    .option("--wait", "block and stream progress until the fix is terminal")
    .option("--no-quota-check", "skip the pre-flight quota check")
    .action(async (repositoryId: string, opts: RunOpts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveRepositoryId(ctx.client, repositoryId);

        if (opts.quotaCheck) {
          await assertPrQuotaAvailable(ctx.client);
        }

        const findingIds = opts.findingIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (findingIds.length === 0) {
          throw new Error("--finding-ids must contain at least one finding id");
        }

        const instructions = opts.instructions ?? (await promptInstructions());
        const sourceRepo = opts.sourceRepo ?? (await resolveSourceRepo(ctx.client, resolved));
        const provider = toProvider(opts.sourceRepoProvider ?? "github");

        const body: FixCreateRequest = {
          finding_ids: findingIds,
          title: opts.title ?? DEFAULT_TITLE,
          instructions,
          source_repo: sourceRepo,
          source_repo_provider: provider,
          ...(opts.sourceScanBranch ? { source_scan_branch: opts.sourceScanBranch } : {}),
        };

        const fix = await createFix(ctx.client, resolved, body);
        if (globals.json && !opts.wait) {
          renderJson(fix);
          return;
        }
        if (!globals.json) {
          process.stdout.write(
            chalk.green("Started fix ") + chalk.cyan(fix.id) + chalk.dim(` (${fix.status})\n`),
          );
        }
        if (!opts.wait) return;

        await pollFixProgress(ctx.client, resolved, fix.id, {
          mode: "wait",
          intervalMs: 5000,
          asJson: Boolean(globals.json),
          resumeHint: `kolega fixes progress ${repositoryId} ${fix.id}`,
        });
      } catch (err) {
        handleError(err);
      }
    });

  fixes
    .command("get <repository-id> <fix-id>")
    .description("Show a single fix")
    .action(async (repositoryId: string, fixId: string, _opts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveRepositoryId(ctx.client, repositoryId);
        const fix = await getFix(ctx.client, resolved, fixId);
        if (globals.json) {
          renderJson(fix);
          return;
        }
        renderFix(fix);
      } catch (err) {
        handleError(err);
      }
    });

  fixes
    .command("progress <repository-id> <fix-id>")
    .description("Show fix progress; pass --watch to tail it")
    .option("--watch", "poll until the fix reaches a terminal state")
    .option("--interval <seconds>", "poll interval when --watch is set", "5")
    .action(async (repositoryId: string, fixId: string, opts: ProgressOpts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveRepositoryId(ctx.client, repositoryId);

        if (!opts.watch) {
          const progress = await getFixProgress(ctx.client, resolved, fixId);
          if (globals.json) {
            renderJson(progress);
          } else {
            const state: FixHeartbeatRenderState = { lastRender: "" };
            renderFixHeartbeat(progress, state);
          }
          return;
        }

        const intervalMs = Math.max(1, Number(opts.interval ?? "5")) * 1000;
        await pollFixProgress(ctx.client, resolved, fixId, {
          mode: "watch",
          intervalMs,
          asJson: Boolean(globals.json),
          resumeHint: `kolega fixes progress ${repositoryId} ${fixId}`,
        });
      } catch (err) {
        handleError(err);
      }
    });

  fixes
    .command("diff <repository-id> <fix-id>")
    .description("Show the diff for a fix (may be null if still running)")
    .action(async (repositoryId: string, fixId: string, _opts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveRepositoryId(ctx.client, repositoryId);
        const diff = await getFixDiff(ctx.client, resolved, fixId);
        if (globals.json) {
          renderJson(diff);
          return;
        }
        if (diff.diff === null || diff.diff === undefined) {
          process.stdout.write(
            chalk.dim("Fix is not ready yet — current status: ") + diff.status + "\n",
          );
          return;
        }
        process.stdout.write(diff.diff + (diff.diff.endsWith("\n") ? "" : "\n"));
      } catch (err) {
        handleError(err);
      }
    });

  fixes
    .command("pr <repository-id> <fix-id>")
    .description("Open pull requests for a completed fix")
    .option("--title <text>", "PR title")
    .option("--body <text>", "PR body")
    .option("--branch-name <name>", "custom branch name")
    .action(async (repositoryId: string, fixId: string, opts: PrOpts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveRepositoryId(ctx.client, repositoryId);
        const response = await createFixPullRequests(ctx.client, resolved, fixId, {
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.body ? { body: opts.body } : {}),
          ...(opts.branchName ? { branch_name: opts.branchName } : {}),
        });
        if (globals.json) {
          renderJson(response);
          return;
        }
        process.stdout.write(chalk.green("Created pull requests:\n"));
        for (const pr of response.pull_requests) {
          process.stdout.write(
            `  ${chalk.cyan(pr.repo_full_name)}#${pr.pr_number}  ${pr.pr_url}  ${chalk.dim(pr.merge_status)}\n`,
          );
        }
      } catch (err) {
        handleError(err);
      }
    });

  fixes
    .command("refine <repository-id> <fix-id>")
    .description("Refine a fix with follow-up instructions (re-runs the agent)")
    .option("--instructions <text>", "refinement instructions (prompts if omitted)")
    .option("--wait", "block and stream progress until the fix is terminal")
    .action(async (repositoryId: string, fixId: string, opts: RefineOpts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveRepositoryId(ctx.client, repositoryId);
        const instructions = opts.instructions ?? (await promptInstructions());
        const body: FixRefineRequest = { instructions };
        const fix = await refineFix(ctx.client, resolved, fixId, body);
        if (globals.json && !opts.wait) {
          renderJson(fix);
          return;
        }
        if (!globals.json) {
          process.stdout.write(
            chalk.green("Refining fix ") + chalk.cyan(fix.id) + chalk.dim(` (${fix.status})\n`),
          );
        }
        if (!opts.wait) return;
        await pollFixProgress(ctx.client, resolved, fix.id, {
          mode: "wait",
          intervalMs: 5000,
          asJson: Boolean(globals.json),
          resumeHint: `kolega fixes progress ${repositoryId} ${fix.id}`,
        });
      } catch (err) {
        handleError(err);
      }
    });

  fixes
    .command("cancel <repository-id> <fix-id>")
    .description("Cancel a pending or running fix")
    .action(async (repositoryId: string, fixId: string, _opts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveRepositoryId(ctx.client, repositoryId);
        const fix = await cancelFix(ctx.client, resolved, fixId);
        if (globals.json) {
          renderJson(fix);
          return;
        }
        process.stdout.write(
          chalk.yellow("Cancelled fix ") + chalk.cyan(fix.id) + chalk.dim(` (${fix.status})\n`),
        );
      } catch (err) {
        handleError(err);
      }
    });
}

async function promptInstructions(): Promise<string> {
  const answers = await inquirer.prompt<{ instructions: string }>([
    {
      type: "editor",
      name: "instructions",
      message: "Fix instructions:",
      validate: (v: string) => v.trim().length > 0 || "Instructions must not be empty",
    },
  ]);
  return answers.instructions.trim();
}

async function resolveSourceRepo(client: ApiClient, repositoryId: string): Promise<string> {
  const repository = await getRepository(client, repositoryId);
  const repos: RepositoryRef[] = repository.repositories ?? [];
  if (repos.length === 0) {
    throw new Error(
      "This repository has no source repositories attached. Pass --source-repo <owner/repo>.",
    );
  }
  if (repos.length === 1) {
    return repos[0]!.full_name;
  }
  const answers = await inquirer.prompt<{ repo: string }>([
    {
      type: "list",
      name: "repo",
      message: "Select the source repo:",
      choices: repos.map((r) => ({ name: r.full_name, value: r.full_name })),
    },
  ]);
  return answers.repo;
}

function toProvider(input: string): "github" | "gitlab" | "azure_devops" {
  const normalized = input.toLowerCase();
  if (normalized === "github" || normalized === "gitlab" || normalized === "azure_devops") {
    return normalized;
  }
  throw new Error(
    `Unknown source repo provider "${input}". Expected one of: github, gitlab, azure_devops.`,
  );
}

async function assertPrQuotaAvailable(client: ApiClient): Promise<void> {
  const balance = await getQuotaBalance(client);
  if (balance.prs.remaining <= 0) {
    throw new ApiError("You're out of prs for this period.", {
      status: 403,
      errorCode: "OPERATION_FAILED",
      quotaType: "prs",
      detail: { period_end: balance.period_end },
    });
  }
}
