/**
 * Locating the `claude` binary and checking its version. v2 depends on
 * stream-json behavior verified on CLI 2.1.287, so older CLIs are refused
 * instead of probing `--help` for individual flags.
 */

import { execFile } from "node:child_process";
import { buildChildEnv } from "./child-env.js";

export const CLAUDE_BIN_ENV = "CLAUDECODE_MCP_CLAUDE_BIN";
export const MIN_CLAUDE_VERSION = "2.1.287";
const VERSION_TIMEOUT_MS = 15_000;
const VERSION_MAX_OUTPUT = 64 * 1024;

export function getClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env[CLAUDE_BIN_ENV] || "claude";
}

export type Version = readonly [number, number, number];

/** Parse the leading `X.Y.Z` of `claude --version` output (e.g. "2.1.288 (Claude Code)"). */
export function parseVersion(text: string): Version | null {
  const m = /^\s*v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?![\d.])/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

export class ClaudeVersionError extends Error {
  readonly code = "ECLAUDEVERSION" as const;
  constructor(message: string) {
    super(message);
    this.name = "ClaudeVersionError";
  }
}

/**
 * Run `claude --version` and require at least MIN_CLAUDE_VERSION. Resolves
 * to the version string; rejects with ClaudeVersionError otherwise.
 */
export function checkClaudeVersion(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const bin = getClaudeBin(env);
  const min = parseVersion(MIN_CLAUDE_VERSION)!;
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["--version"],
      {
        env: buildChildEnv({ parentEnv: env }),
        timeout: VERSION_TIMEOUT_MS,
        maxBuffer: VERSION_MAX_OUTPUT,
        encoding: "utf8",
      },
      (err, stdout) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          reject(
            new ClaudeVersionError(
              code === "ENOENT"
                ? `claude CLI not found (${bin}); install Claude Code or set ${CLAUDE_BIN_ENV}`
                : `\`${bin} --version\` failed: ${err.message.slice(0, 200)}`,
            ),
          );
          return;
        }
        const version = parseVersion(stdout);
        if (!version) {
          reject(
            new ClaudeVersionError(`cannot parse claude version from: ${stdout.slice(0, 80)}`),
          );
          return;
        }
        const text = version.join(".");
        if (compareVersions(version, min) < 0) {
          reject(
            new ClaudeVersionError(
              `claude CLI ${text} is too old; claudecode-mcp needs ${MIN_CLAUDE_VERSION} or newer`,
            ),
          );
          return;
        }
        resolve(text);
      },
    );
  });
}
