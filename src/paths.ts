/**
 * File locations: the config file and the state directory. Both follow the
 * XDG base-directory spec and can be overridden for tests and odd setups.
 */

import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const APP_DIR = "claudecode-mcp";
export const CONFIG_PATH_ENV = "CLAUDECODE_MCP_CONFIG";
export const STATE_DIR_ENV = "CLAUDECODE_MCP_STATE_DIR";

/** Expand a leading `~` or `~/`. Other `~user` forms are left alone. */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** Per the XDG spec, a relative or empty value is invalid and ignored. */
function xdgDir(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key];
  return value && isAbsolute(value) ? value : join(homedir(), fallback);
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CONFIG_PATH_ENV];
  if (override) return resolve(expandHome(override));
  return join(xdgDir(env, "XDG_CONFIG_HOME", ".config"), APP_DIR, "config.json");
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[STATE_DIR_ENV];
  if (override) return resolve(expandHome(override));
  return join(xdgDir(env, "XDG_STATE_HOME", join(".local", "state")), APP_DIR);
}

export function tasksDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "tasks");
}

export class StateDirError extends Error {
  readonly code = "ESTATEDIR" as const;
  constructor(message: string) {
    super(message);
    this.name = "StateDirError";
  }
}

/**
 * Create the state dir and its `tasks/` folder with mode 0700. The state dir
 * will hold runner sockets and transcripts, so it must be a real directory
 * (not a symlink) owned by the current user; a looser mode is tightened.
 */
export function ensureStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = stateDir(env);
  const tasks = tasksDir(env);
  // Check each level before creating the next, so nothing is ever created
  // through a symlinked state dir.
  for (const dir of [base, tasks]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory()) {
      throw new StateDirError(`state path is not a directory: ${dir}`);
    }
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new StateDirError(`state directory is owned by another user: ${dir}`);
    }
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
  return base;
}
