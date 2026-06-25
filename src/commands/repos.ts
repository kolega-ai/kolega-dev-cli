import type { Command } from "commander";
import { getRepository, listRepositories, resolveRepositoryId } from "../api/repositories.js";
import { renderRepository, renderRepositoriesTable, renderJson } from "../ui/render.js";
import { handleError } from "../ui/errors.js";
import { buildContext, type GlobalOptions } from "./context.js";

interface ListOptions {
  includeArchived?: boolean;
  limit?: string;
  skip?: string;
}

export function registerReposCommands(program: Command, pkgVersion: string): void {
  const repos = program.command("repos").description("Manage repositories");

  repos
    .command("list")
    .description("List repositories for the current organization")
    .option("--include-archived", "include archived repositories")
    .option("--limit <n>", "page size", "50")
    .option("--skip <n>", "number of items to skip", "0")
    .action(async (opts: ListOptions, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const response = await listRepositories(ctx.client, {
          includeArchived: opts.includeArchived,
          limit: opts.limit ? Number(opts.limit) : undefined,
          skip: opts.skip ? Number(opts.skip) : undefined,
        });
        if (globals.json) {
          renderJson(response);
          return;
        }
        renderRepositoriesTable(response.items);
      } catch (err) {
        handleError(err);
      }
    });

  repos
    .command("get <repository-id>")
    .description("Show a single repository")
    .action(async (repositoryId: string, _opts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const resolved = await resolveRepositoryId(ctx.client, repositoryId);
        const repo = await getRepository(ctx.client, resolved);
        if (globals.json) {
          renderJson(repo);
          return;
        }
        renderRepository(repo);
      } catch (err) {
        handleError(err);
      }
    });
}
