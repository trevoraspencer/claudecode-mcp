/**
 * The stdio MCP server. Thin by design: task state lives on disk and in the
 * per-task runner processes, not here.
 *
 * Build step 1 wires startup only (config, state dir, depth guard). It
 * registers no tools yet; the task tools arrive in build step 3.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { currentDepth } from "./depth.js";
import { debugLog, warnLog } from "./log.js";
import { ensureStateDir } from "./paths.js";

export function getPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface ServerContext {
  loaded: LoadedConfig;
  stateDir: string;
  depth: number;
}

/**
 * Load config and prepare the state dir. Throws on an invalid config so the
 * process fails at startup, not on the first tool call.
 */
export function prepare(env: NodeJS.ProcessEnv = process.env): ServerContext {
  const loaded = loadConfig(env);
  const stateDir = ensureStateDir(env);
  const depth = currentDepth(env);
  debugLog({
    phase: "startup",
    config_path: loaded.path,
    config_source: loaded.source,
    profiles: Object.keys(loaded.config.profiles),
    state_dir: stateDir,
    depth,
  });
  if (depth >= 1) {
    warnLog({ phase: "startup", depth, message: "nested inside a task; task tools disabled" });
  }
  return { loaded, stateDir, depth };
}

export function createServer(_ctx: ServerContext): Server {
  const server = new Server(
    { name: "claudecode-mcp", version: getPackageVersion() },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    isError: true,
    content: [{ type: "text", text: `unknown tool: ${String(req.params.name).slice(0, 100)}` }],
  }));
  return server;
}

export async function serve(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const ctx = prepare(env);
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
}
