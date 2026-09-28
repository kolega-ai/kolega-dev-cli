/**
 * Library entry point: `import { createMcpServer, ApiClient } from "@kolegaai/cli/mcp"`.
 *
 * Used by the hosted Kolega DevSec MCP server to serve the same tools as
 * `kolega mcp` over Streamable HTTP. Deliberately imports nothing from
 * `commands/` or `config/`, so it pulls in no CLI-only dependencies
 * (commander, inquirer, ora, …) and never touches the local config file.
 */
export {
  createMcpServer,
  describeError,
  DEFAULT_REAUTH_HINT,
  MAX_WAIT_SECONDS,
  MCP_SERVER_NAME,
  type McpServerOptions,
} from "./server.js";
export { ApiClient, ApiError, buildUserAgent, type ApiClientOptions } from "../api/client.js";
