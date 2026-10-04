/**
 * Git and gh helpers for worktree tasks. Every call is an argv array with a
 * timeout; nothing goes through a shell.
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
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
  // GIT_TERMINAL_PROMPT does not cover ssh, which prompts on /dev/tty.
  if (!out.GIT_SSH_COMMAND) out.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return out;
}

/**
 * Run a command; resolves with its exit code instead of throwing on non-zero.
 * Rejects only if it cannot start (for example ENOENT) or times out. Output
 * beyond the cap is cut and flagged `truncated`.
 */
export function run(
  cmd: string,
  args: readonly string[],
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: toolEnv(opts.env ?? process.env),
      // A new session has no controlling terminal and stdin is closed, so
      // nothing (ssh, credential helpers, editors) can prompt the user.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    child.stdout.on("data", (b: Buffer) => {
      if (outBytes + b.length > MAX_BUFFER) {
        truncated = true;
        b = b.subarray(0, Math.max(0, MAX_BUFFER - outBytes));
      }
      outBytes += b.length;
      if (b.length) out.push(b);
      if (truncated) killTree(child.pid);
    });
    child.stderr.on("data", (b: Buffer) => {
      if (errBytes < 64 * 1024) {
        errOut.push(b);
        errBytes += b.length;
      }
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs ?? GIT_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(errOut).toString("utf8");
      if (timedOut) {
        const err = new GitError(`${cmd} ${args[0] ?? ""} timed out`) as GitError & {
          timedOut?: boolean;
        };
        err.timedOut = true;
        reject(err);
        return;
      }
      resolve({
        stdout,
        stderr,
        code: truncated ? -1 : (code ?? -1),
        ...(truncated ? { truncated } : {}),
      });
    });
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
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

/** True if `top` is a linked worktree (for example another task's), not the main checkout. */
export async function isLinkedWorktree(top: string): Promise<boolean> {
  const out = await git(["rev-parse", "--absolute-git-dir", "--git-common-dir"], top);
  const [gitDir, common] = out.trim().split("\n");
  const commonAbs = common && isAbsolute(common) ? common : join(top, common ?? "");
  return realpathSync.native(gitDir ?? "") !== realpathSync.native(commonAbs);
}

export async function createWorktree(opts: {
  repo: string;
  /** Repo top level, already checked against allowed_roots by the caller. */
  top: string;
  taskId: string;
  baseRef?: string;
  title: string;
}): Promise<NewWorktree> {
  const { top } = opts;
  if (await isLinkedWorktree(top)) {
    throw new GitError(
      `${top} is a linked worktree (another task's?); start from the main checkout or pass isolation: "in_place"`,
    );
  }
  let base: string;
  try {
    base = await resolveCommit(top, opts.baseRef ?? "HEAD");
  } catch (err) {
    if (opts.baseRef) throw err;
    throw new GitError(
      `repo has no commits yet: ${top}; commit first or pass isolation: "in_place"`,
    );
  }
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
  const sub = relative(top, opts.repo);
  const workdir = sub ? join(worktree, sub) : worktree;
  try {
    // Checkout plus hooks can be slow on big repos.
    await git(["worktree", "add", "-b", branch, worktree, base], top, { timeoutMs: 300_000 });
    if (!existsSync(workdir)) {
      throw new GitError(
        `${sub} does not exist in the new worktree (untracked or ignored folder?); pass isolation: "in_place"`,
      );
    }
  } catch (err) {
    // Leave no half-made worktree or branch behind.
    await run("git", ["worktree", "remove", "--force", worktree], top).catch(() => {});
    await run("git", ["worktree", "prune"], top).catch(() => {});
    await run("git", ["branch", "-D", branch], top).catch(() => {});
    throw err;
  }
  return { repo_root: top, worktree, workdir, branch, base_commit: base };
}

/** Other worktrees located inside `dir` (they would be deleted with it). */
export async function nestedWorktrees(repoRoot: string, dir: string): Promise<string[]> {
  const out = await git(["worktree", "list", "--porcelain"], repoRoot);
  const prefix = dir.endsWith("/") ? dir : dir + "/";
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => p.startsWith(prefix));
}

/** The branch checked out in `dir`, or null when HEAD is detached. */
export async function currentBranch(dir: string): Promise<string | null> {
  const r = await run("git", ["symbolic-ref", "-q", "HEAD"], dir);
  const ref = r.stdout.trim();
  return r.code === 0 && ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

/** Ignored paths in `dir` (folders collapsed); they are deleted with the worktree. */
export async function ignoredPaths(dir: string): Promise<string[]> {
  const r = await run(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    dir,
  );
  return r.code === 0 ? r.stdout.split("\0").filter(Boolean) : [];
}

export async function removeWorktree(repoRoot: string, worktree: string, force: boolean) {
  await git(["worktree", "remove", ...(force ? ["--force"] : []), worktree], repoRoot);
}

/**
 * Paths with uncommitted changes (tracked or untracked) in `dir`. Output too
 * large to read counts as dirty.
 */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const r = await run("git", ["status", "--porcelain", "-z", "--untracked-files=all"], dir);
  if (r.truncated) return ["(more changes than git status output can hold)"];
  if (r.code !== 0) throw new GitError(`git status failed: ${r.stderr.trim().slice(0, 500)}`);
  const entries = r.stdout.split("\0");
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

/**
 * argv for pushing a task branch. When the server has `GH_TOKEN` (or
 * `GITHUB_TOKEN`) in its own environment, this one push also gets gh as a
 * git credential helper, so https pushes use the server's token. Tasks never
 * see that variable (it is not in the child allowlist), so only the server
 * can push. The refspec is explicit: the task branch, nothing else.
 */
export function pushArgs(branch: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const gh = ghBin(env);
  const helper =
    (env.GH_TOKEN || env.GITHUB_TOKEN) && /^[A-Za-z0-9_./-]+$/.test(gh)
      ? ["-c", `credential.helper=!${gh} auth git-credential`]
      : [];
  return [...helper, "push", "-u", "origin", `refs/heads/${branch}:refs/heads/${branch}`];
}
