import type { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "../mcp/server.js";
import { handleError } from "../ui/errors.js";
import { buildContext, type GlobalOptions } from "./context.js";

export function registerMcpCommand(program: Command, pkgVersion: string): void {
  program
    .command("mcp")
    .description(
      "Run the Kolega DevSec MCP server over stdio (for Claude Code, Cursor, Claude Desktop, …)",
    )
    .action(async (_opts, cmd) => {
      try {
        const globals = (cmd.parent?.opts() as GlobalOptions | undefined) ?? {};
        // stdout is the MCP protocol channel — never write anything else to it.
        const ctx = await buildContext(globals, pkgVersion);
        const server = createMcpServer({ client: ctx.client, version: pkgVersion });
        const transport = new StdioServerTransport();
        await server.connect(transport);
        process.stderr.write(
          `kolega mcp: serving ${ctx.baseUrl} (token from ${ctx.tokenSource}) on stdio\n`,
        );
        await new Promise<void>((resolve) => {
          transport.onclose = () => resolve();
        });
      } catch (err) {
        handleError(err);
      }
    });
}
