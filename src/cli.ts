#!/usr/bin/env node
/**
 * Package entry point (`claudecode-mcp`).
 *
 *   claudecode-mcp              start the stdio MCP server
 *   claudecode-mcp --http       start the HTTP MCP server (DESIGN-v2 section 12)
 *   claudecode-mcp token add|list|revoke
 *                               manage per-device bearer tokens for --http
 *   claudecode-mcp runner <id>  run one task (started detached by the server)
 *   claudecode-mcp prune-workspaces [--dry-run] [--force]
 *                               remove managed clones no open task uses
 *   claudecode-mcp list-personal-config
 *                               print personal hooks and skills for profiles
 *   claudecode-mcp --version
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { currentDepth } from "./depth.js";
import { runHttp } from "./http.js";
import { addToken, readTokens, revokeToken, tokensFilePath } from "./http-tokens.js";
import { fatalLog } from "./log.js";
import { redactSecrets } from "./redaction.js";
import { describePersonalConfig } from "./profile.js";
import { pruneWorkspaces } from "./workspaces.js";
import { runRunner } from "./runner.js";
import { getPackageVersion, serve } from "./server.js";

export const MIN_NODE_MAJOR = 22;

const USAGE = `usage: claudecode-mcp [--http | --version | --help]
       claudecode-mcp token add <device-name> | token list | token revoke <device-name>
       claudecode-mcp prune-workspaces [--dry-run] [--force]
       claudecode-mcp list-personal-config
       claudecode-mcp runner <task-id>`;

function fatal(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  fatalLog({
    error_class: err instanceof Error ? err.constructor.name : typeof err,
    error: redactSecrets(msg).slice(0, 2000),
  });
  process.exit(1);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(
      `claudecode-mcp needs Node ${MIN_NODE_MAJOR} or newer (running ${process.versions.node})`,
    );
  }
  if (process.platform === "win32") {
    throw new Error("claudecode-mcp supports macOS and Linux only");
  }
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
      await serve();
      return 0;
    case "--http":
      if (rest.length !== 0) {
        process.stderr.write(USAGE + "\n");
        return 2;
      }
      await runHttp();
      return 0;
    case "token":
      return tokenCommand(rest);
    case "--version":
    case "-v":
      process.stdout.write(getPackageVersion() + "\n");
      return 0;
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return 0;
    case "prune-workspaces":
      return pruneCommand(rest);
    case "list-personal-config":
      process.stdout.write(describePersonalConfig());
      return 0;
    case "runner":
      if (rest.length !== 1) {
        process.stderr.write(USAGE + "\n");
        return 2;
      }
      // The runner holds no MCP transport; exit as soon as it is done.
      process.exit(await runRunner(rest[0]!));
    default:
      process.stderr.write(`unknown command: ${String(cmd).slice(0, 100)}\n${USAGE}\n`);
      return 2;
  }
}

/** `prune-workspaces`: remove managed clones that no open task uses. */
async function pruneCommand(args: readonly string[]): Promise<number> {
  const flags = new Set(args);
  if ([...flags].some((f) => f !== "--dry-run" && f !== "--force") || flags.size !== args.length) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }
  if (currentDepth() >= 1) {
    throw new Error("prune-workspaces refuses to run inside a delegated task");
  }
  const dryRun = flags.has("--dry-run");
  const result = await pruneWorkspaces(loadConfig().config, process.env, {
    dryRun,
    force: flags.has("--force"),
  });
  for (const c of result.removed)
    process.stdout.write(`${dryRun ? "would remove" : "removed"}\t${c}\n`);
  for (const k of result.kept) process.stdout.write(`kept\t${k.clone}\t${k.reason}\n`);
  if (result.removed.length + result.kept.length === 0) process.stderr.write("no managed clones\n");
  return 0;
}

/** `token add|list|revoke`: manage the per-device tokens file for --http. */
function tokenCommand(args: readonly string[]): number {
  const [sub, name, ...extra] = args;
  const needsName = sub === "add" || sub === "revoke";
  if (extra.length > 0 || (needsName ? !name : name !== undefined || sub !== "list")) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }
  // A delegated task runs as the same user; letting it mint a token would let
  // it reach a depth-0 server over loopback and get around the depth guard.
  if (currentDepth() >= 1) {
    throw new Error(
      "token commands refuse to run inside a delegated task (CLAUDECODE_MCP_DEPTH >= 1)",
    );
  }
  const path = tokensFilePath(loadConfig().config);
  if (sub === "list") {
    const tokens = readTokens(path);
    for (const t of tokens) process.stdout.write(`${t.name}\t${t.created_at}\n`);
    if (tokens.length === 0) process.stderr.write(`no tokens in ${path}\n`);
    return 0;
  }
  if (sub === "add") {
    const token = addToken(path, name!);
    process.stdout.write(token + "\n");
    process.stderr.write(
      `Added token for "${name}" to ${path}. It is shown only once; store it on that device.\n`,
    );
    return 0;
  }
  revokeToken(path, name!);
  process.stderr.write(`Revoked "${name}". A running --http server stops accepting it at once.\n`);
  return 0;
}

/**
 * Compare canonical paths so importing this module from an unrelated script
 * with the same basename cannot start the server. realpath keeps npm's
 * symlinked `.bin` entry working.
 */
export function isMainModule(entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then(
    (code) => {
      // The server keeps the event loop alive; only short commands exit here.
      if (code !== 0) process.exitCode = code;
    },
    (err) => fatal(err),
  );
}
