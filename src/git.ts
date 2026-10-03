/**
 * Git and gh helpers for worktree tasks. Every call is an argv array with a
 * timeout; nothing goes through a shell.
 */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;
export const GH_BIN_ENV = "CLAUDECODE_MCP_GH_BIN";

/** Variables that would point git at a different repo or index. */
const GIT_REDIRECT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
];

export class GitError extends Error {
  readonly code = "EGIT" as const;
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  /** stdout hit the buffer cap and was cut. */
  truncated?: boolean;
}

function toolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  for (const key of GIT_REDIRECT_VARS) delete out[key];
  return out;
}

/** Run a command; resolves with its exit code instead of throwing on non-zero. */
export function run(
  cmd: string,
  args: readonly string[],
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        env: toolEnv(opts.env ?? process.env),
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ stdout, stderr, code: -1, truncated: true });
          return;
        }
        if (err && typeof code !== "number") {
          reject(err);
          return;
        }
        resolve({ stdout, stderr, code: err ? Number((err as { code?: number }).code) : 0 });
      },
    );
  });
}

/** Run git and return stdout; throw GitError on a non-zero exit. */
export async function git(
  args: readonly string[],
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string> {
  const r = await run("git", args, cwd, opts);
  if (r.code !== 0) {
    throw new GitError(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  }
  return r.stdout;
}

/** Top level of the repo containing `dir`, or null if it is not in one. */
export async function repoTop(dir: string): Promise<string | null> {
  const r = await run("git", ["rev-parse", "--show-toplevel"], dir);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Refs come from callers: no options, no spaces or control characters. */
export function assertRef(ref: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]{0,255}$/.test(ref)) {
    throw new GitError(`invalid git ref: ${ref.slice(0, 80)}`);
  }
}

export async function resolveCommit(dir: string, ref: string): Promise<string> {
  assertRef(ref);
  const r = await run(
    "git",
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    dir,
  );
  if (r.code !== 0) throw new GitError(`unknown git ref: ${ref}`);
  return r.stdout.trim();
}

/** A branch-name-safe slug from free text. */
export function slugify(text: string, max = 30): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "task";
}

/**
 * Keep task worktrees out of the user's `git status` with a local exclude
 * entry (`.git/info/exclude`, never committed).
 */
export async function ensureWorktreeExclude(repoRoot: string): Promise<void> {
  const commonDir = (await git(["rev-parse", "--git-common-dir"], repoRoot)).trim();
  const gitDir = isAbsolute(commonDir) ? commonDir : join(repoRoot, commonDir);
  const exclude = join(gitDir, "info", "exclude");
  const line = "/.claude/worktrees/";
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === line)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(exclude, `${prefix}# claudecode-mcp task worktrees\n${line}\n`);
}

export interface NewWorktree {
  repo_root: string;
  worktree: string;
  /** Where Claude starts: the worktree, or the same subfolder the caller named. */
  workdir: string;
  branch: string;
  base_commit: string;
}

export async function createWorktree(opts: {
  repo: string;
  taskId: string;
  baseRef?: string;
  title: string;
}): Promise<NewWorktree> {
  const top = await repoTop(opts.repo);
  if (!top) {
    throw new GitError(`not a git repository: ${opts.repo}; pass isolation: "in_place"`);
  }
  const base = await resolveCommit(top, opts.baseRef ?? "HEAD");
  const branch = `claude/${slugify(opts.title)}-${opts.taskId.slice(1, 7)}`;
  // A symlinked .claude or worktrees folder could put the worktree outside
  // the repo (and outside allowed_roots).
  for (const dir of [join(top, ".claude"), join(top, ".claude", "worktrees")]) {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
      throw new GitError(`refusing to create a worktree through a symlink: ${dir}`);
    }
  }
  const worktree = join(top, ".claude", "worktrees", opts.taskId);
  await ensureWorktreeExclude(top);
  await git(["worktree", "add", "-b", branch, worktree, base], top);
  const sub = relative(top, opts.repo);
  return {
    repo_root: top,
    worktree,
    workdir: sub ? join(worktree, sub) : worktree,
    branch,
    base_commit: base,
  };
}

export async function removeWorktree(repoRoot: string, worktree: string, force: boolean) {
  await git(["worktree", "remove", ...(force ? ["--force"] : []), worktree], repoRoot);
}

/** Paths with uncommitted changes (tracked or untracked) in `dir`. */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const out = await git(["status", "--porcelain", "-z", "--untracked-files=all"], dir);
  const entries = out.split("\0");
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry) continue;
    files.push(entry.slice(3));
    // Renames and copies are followed by the original path; skip it.
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return files;
}

export function ghBin(env: NodeJS.ProcessEnv = process.env): string {
  return env[GH_BIN_ENV] || "gh";
}
