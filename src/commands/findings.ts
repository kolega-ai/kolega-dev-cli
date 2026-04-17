import type { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";

import { resolveApplicationId } from "../api/applications.js";
import { getFinding, listFindings, setFindingStatus } from "../api/findings.js";
import { renderFinding, renderFindingsTable, renderJson } from "../ui/render.js";
import { handleError } from "../ui/errors.js";
import { buildContext, type GlobalOptions } from "./context.js";
import { FINDING_STATUSES, type FindingStatus } from "../api/types.js";

interface ListOpts {
  severity?: string;
  status?: string;
  scanBatchId?: string;
  scanType?: string;
  limit?: string;
  skip?: string;
}

export function registerFindingsCommands(program: Command, pkgVersion: string): void {
  const findings = program.command("findings").description("Security findings");

  findings
    .command("list <application-id>")
    .description("List findings for an application")
    .option("--severity <severity>", "filter by severity")
    .option("--status <status>", "filter by status")
    .option("--scan-batch-id <id>", "filter by scan batch id")
    .option("--scan-type <type>", "filter by scan type")
    .option("--limit <n>", "page size", "50")
    .option("--skip <n>", "number of items to skip", "0")
    .action(async (applicationId: string, opts: ListOpts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveApplicationId(ctx.client, applicationId);
        const response = await listFindings(ctx.client, resolved, {
          severity: opts.severity,
          status: opts.status,
          scanBatchId: opts.scanBatchId,
          scanType: opts.scanType,
          limit: opts.limit ? Number(opts.limit) : undefined,
          skip: opts.skip ? Number(opts.skip) : undefined,
        });
        if (globals.json) {
          renderJson(response);
          return;
        }
        renderFindingsTable(response.items);
      } catch (err) {
        handleError(err);
      }
    });

  findings
    .command("get <application-id> <finding-id>")
    .description("Show a single finding")
    .action(async (applicationId: string, findingId: string, _opts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveApplicationId(ctx.client, applicationId);
        const finding = await getFinding(ctx.client, resolved, findingId);
        if (globals.json) {
          renderJson(finding);
          return;
        }
        renderFinding(finding);
      } catch (err) {
        handleError(err);
      }
    });

  findings
    .command("set-status <application-id> <finding-id> [status]")
    .description("Update a finding's status (prompts if omitted)")
    .action(
      async (applicationId: string, findingId: string, status: string | undefined, _opts, cmd) => {
        try {
          const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
          const ctx = await buildContext(globals, pkgVersion);
          const resolved = await resolveApplicationId(ctx.client, applicationId);

          let finalStatus: FindingStatus;
          if (status) {
            if (!(FINDING_STATUSES as readonly string[]).includes(status)) {
              throw new Error(
                `Unknown status "${status}". Expected one of: ${FINDING_STATUSES.join(", ")}.`,
              );
            }
            finalStatus = status as FindingStatus;
          } else {
            const answers = await inquirer.prompt<{ status: FindingStatus }>([
              {
                name: "status",
                type: "list",
                message: "New status:",
                choices: FINDING_STATUSES.map((s) => ({ name: s, value: s })),
              },
            ]);
            finalStatus = answers.status;
          }

          const updated = await setFindingStatus(ctx.client, resolved, findingId, finalStatus);
          if (globals.json) {
            renderJson(updated);
            return;
          }
          process.stdout.write(
            chalk.green("Updated ") + chalk.cyan(findingId) + chalk.dim(` → ${finalStatus}\n`),
          );
        } catch (err) {
          handleError(err);
        }
      },
    );
}
