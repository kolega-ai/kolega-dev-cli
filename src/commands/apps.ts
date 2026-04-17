import type { Command } from "commander";
import { getApplication, listApplications, resolveApplicationId } from "../api/applications.js";
import { renderApplication, renderApplicationsTable, renderJson } from "../ui/render.js";
import { handleError } from "../ui/errors.js";
import { buildContext, type GlobalOptions } from "./context.js";

interface ListOptions {
  includeArchived?: boolean;
  limit?: string;
  skip?: string;
}

export function registerAppsCommands(program: Command, pkgVersion: string): void {
  const apps = program.command("apps").description("Manage applications");

  apps
    .command("list")
    .description("List applications for the current organization")
    .option("--include-archived", "include archived applications")
    .option("--limit <n>", "page size", "50")
    .option("--skip <n>", "number of items to skip", "0")
    .action(async (opts: ListOptions, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const response = await listApplications(ctx.client, {
          includeArchived: opts.includeArchived,
          limit: opts.limit ? Number(opts.limit) : undefined,
          skip: opts.skip ? Number(opts.skip) : undefined,
        });
        if (globals.json) {
          renderJson(response);
          return;
        }
        renderApplicationsTable(response.items);
      } catch (err) {
        handleError(err);
      }
    });

  apps
    .command("get <application-id>")
    .description("Show a single application")
    .action(async (applicationId: string, _opts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveApplicationId(ctx.client, applicationId);
        const app = await getApplication(ctx.client, resolved);
        if (globals.json) {
          renderJson(app);
          return;
        }
        renderApplication(app);
      } catch (err) {
        handleError(err);
      }
    });
}
