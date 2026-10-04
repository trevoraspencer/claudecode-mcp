#!/usr/bin/env node
/**
 * Package entry point (`claudecode-mcp`).
 *
 *   claudecode-mcp              start the stdio MCP server
 *   claudecode-mcp --http       start the HTTP MCP server (DESIGN-v2 section 12)
 *   claudecode-mcp token add|list|revoke
 *                               manage per-device bearer tokens for --http
 *   claudecode-mcp runner <id>  run one task (started detached by the server)
 *   claudecode-mcp list-personal-config
 *                               print personal hooks and skills for profiles
 *   claudecode-mcp --version
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { runHttp } from "./http.js";
import { addToken, readTokens, revokeToken, tokensFilePath } from "./http-tokens.js";
import { fatalLog } from "./log.js";
import { redactSecrets } from "./redaction.js";
import { describePersonalConfig } from "./profile.js";
import { runRunner } from "./runner.js";
import { getPackageVersion, serve } from "./server.js";

export const MIN_NODE_MAJOR = 22;

const USAGE = `usage: claudecode-mcp [--http | --version | --help]
       claudecode-mcp token add <device-name> | token list | token revoke <device-name>
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

/** `token add|list|revoke`: manage the per-device tokens file for --http. */
function tokenCommand(args: readonly string[]): number {
  const [sub, name, ...extra] = args;
  const needsName = sub === "add" || sub === "revoke";
  if (extra.length > 0 || (needsName ? !name : name !== undefined || sub !== "list")) {
    process.stderr.write(USAGE + "\n");
    return 2;
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
