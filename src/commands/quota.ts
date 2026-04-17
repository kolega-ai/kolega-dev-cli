import type { Command } from "commander";
import { getQuotaBalance } from "../api/quotas.js";
import { renderJson, renderQuota } from "../ui/render.js";
import { handleError } from "../ui/errors.js";
import { buildContext, type GlobalOptions } from "./context.js";

export function registerQuotaCommand(program: Command, pkgVersion: string): void {
  program
    .command("quota")
    .description("Show the current-period quota balance")
    .action(async (_opts, cmd) => {
      try {
        const globals = (cmd.parent?.opts() as GlobalOptions | undefined) ?? {};
        const ctx = await buildContext(globals, pkgVersion);
        const balance = await getQuotaBalance(ctx.client);
        if (globals.json) {
          renderJson(balance);
          return;
        }
        renderQuota(balance);
      } catch (err) {
        handleError(err);
      }
    });
}
