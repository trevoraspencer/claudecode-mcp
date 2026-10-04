/**
 * Managed clones for `repo_url` tasks (DESIGN-v2 section 12.5).
 *
 * One clone per repo at `<workspaces_dir>/<host>/<owner>/<repo>`, made with
 * `git clone --no-checkout` on first use and refreshed with `git fetch
 * --prune` before each task. Callers hold `withRepoLock` around the clone or
 * fetch and the worktree that follows, so one repo is never fetched twice at
 * once. Task worktrees then use the normal step-4 flow inside the clone.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { assertRef, ensureWorktreeExclude, git, GitError, run } from "./git.js";
import { withRepoLock } from "./launcher.js";
import { tasksDir } from "./paths.js";
import { isInside } from "./repo.js";
import { cloneSegments, parseRepoUrl, urlAllowed, type RepoUrl } from "./repo-url.js";
import { readTask, TASK_ID_RE } from "./task-store.js";

export const ALLOW_FILE_URLS_ENV = "CLAUDECODE_MCP_ALLOW_FILE_URLS";
const CLONE_TIMEOUT_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;

export class WorkspaceError extends Error {
  readonly code = "EWORKSPACE" as const;
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

function allowFile(env: NodeJS.ProcessEnv): boolean {
  return env[ALLOW_FILE_URLS_ENV] === "1";
}

/** git env for remote access: only https and ssh (plus file in tests), no submodule tricks. */
function remoteEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, GIT_ALLOW_PROTOCOL: allowFile(env) ? "https:ssh:file" : "https:ssh" };
}

/** Parse a caller's repo_url and check it against `repo_urls`. */
export function checkRepoUrl(raw: string, config: Config, env: NodeJS.ProcessEnv): RepoUrl {
  if (config.repo_urls.length === 0) {
    throw new WorkspaceError("repo_url is not enabled on this server (repo_urls is empty)");
  }
  const url = parseRepoUrl(raw, { allowFile: allowFile(env) });
  const patterns = config.repo_urls.map((p) => parseRepoUrl(p, { pattern: true, allowFile: true }));
  if (!urlAllowed(url, patterns)) {
    throw new WorkspaceError(
      `repo_url is not in this server's repo_urls allowlist: ${url.canonical}`,
    );
  }
  return url;
}

/**
 * Create (0700) and check `workspaces_dir`: a real directory, not a symlink,
 * inside `allowed_roots`. Returns its canonical path.
 */
export function ensureWorkspacesDir(config: Config): string {
  const dir = config.workspaces_dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) {
    throw new WorkspaceError(`workspaces_dir must be a real directory: ${dir}`);
  }
  const real = realpathSync.native(dir);
  const inRoots = config.allowed_roots.some(
    (r) => existsSync(r) && isInside(real, realpathSync.native(r)),
  );
  if (!inRoots) {
    throw new WorkspaceError(`workspaces_dir is outside allowed_roots: ${dir}`);
  }
  return real;
}

/** Where the managed clone for `url` lives (not created). */
export function clonePathFor(url: RepoUrl, workspacesReal: string): string {
  return join(workspacesReal, ...cloneSegments(url));
}

/**
 * Clone or fetch. Call only under `withRepoLock(clone)`. A new clone is made
 * in a temp folder and renamed into place, so a failed clone leaves nothing.
 */
export async function syncClone(
  url: RepoUrl,
  clone: string,
  workspacesReal: string,
  env: NodeJS.ProcessEnv,
): Promise<"cloned" | "fetched"> {
  const parent = dirname(clone);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // Nothing below workspaces_dir may be a symlink out of it.
  if (!isInside(realpathSync.native(parent), workspacesReal)) {
    throw new WorkspaceError(`clone folder escapes workspaces_dir: ${clone}`);
  }
  if (existsSync(clone)) {
    if (lstatSync(clone).isSymbolicLink()) {
      throw new WorkspaceError(`clone folder is a symlink: ${clone}`);
    }
    const top = await run("git", ["rev-parse", "--show-toplevel"], clone);
    if (top.code !== 0 || realpathSync.native(top.stdout.trim()) !== realpathSync.native(clone)) {
      throw new WorkspaceError(`${clone} exists but is not a managed clone; remove it`);
    }
    await git(["fetch", "--prune", "--no-recurse-submodules", "origin"], clone, {
      env: remoteEnv(env),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    // Follow a changed default branch; a failure keeps the old origin/HEAD.
    await run("git", ["remote", "set-head", "origin", "--auto"], clone, {
      env: remoteEnv(env),
      timeoutMs: FETCH_TIMEOUT_MS,
    }).catch(() => {});
    return "fetched";
  }
  const tmp = join(parent, `.clone-${randomBytes(6).toString("hex")}`);
  try {
    await git(
      ["clone", "--no-checkout", "--no-recurse-submodules", "--", url.cloneUrl, tmp],
      parent,
      { env: remoteEnv(env), timeoutMs: CLONE_TIMEOUT_MS },
    );
    renameSync(tmp, clone);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return "cloned";
}

/**
 * The commit to start from. Default: the remote's default branch
 * (`origin/HEAD`). A branch name means the remote branch (`origin/<name>`),
 * since the clone's own branches are never updated; tags and commits work
 * as given.
 */
export async function resolveRemoteBase(clone: string, baseRef?: string): Promise<string> {
  const tryRef = async (ref: string) => {
    const r = await run(
      "git",
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
      clone,
    );
    return r.code === 0 ? r.stdout.trim() : undefined;
  };
  if (baseRef === undefined) {
    const head = await tryRef("refs/remotes/origin/HEAD");
    if (!head)
      throw new WorkspaceError("the remote has no default branch (origin/HEAD); pass base_ref");
    return head;
  }
  assertRef(baseRef);
  for (const ref of [`refs/remotes/origin/${baseRef}`, `refs/tags/${baseRef}`, baseRef]) {
    const sha = await tryRef(ref);
    if (sha) return sha;
  }
  throw new GitError(`unknown git ref: ${baseRef}`);
}

/** Prepare the clone for `url` (clone or fetch) and run `fn` under its repo lock. */
export async function withManagedClone<T>(
  url: RepoUrl,
  config: Config,
  env: NodeJS.ProcessEnv,
  fn: (clone: string) => Promise<T>,
): Promise<T> {
  const ws = ensureWorkspacesDir(config);
  const clone = clonePathFor(url, ws);
  return withRepoLock(clone, env, async () => {
    await syncClone(url, clone, ws, env);
    return fn(clone);
  });
}

/** A detached worktree for `ask` (removed afterwards by `removeAskWorktree`). */
export async function addAskWorktree(clone: string, base: string): Promise<string> {
  for (const dir of [join(clone, ".claude"), join(clone, ".claude", "worktrees")]) {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
      throw new GitError(`refusing to create a worktree through a symlink: ${dir}`);
    }
  }
  await ensureWorktreeExclude(clone);
  const path = join(clone, ".claude", "worktrees", `ask-${randomBytes(6).toString("hex")}`);
  try {
    await git(["worktree", "add", "--detach", path, base], clone, { timeoutMs: 300_000 });
  } catch (err) {
    await run("git", ["worktree", "remove", "--force", path], clone).catch(() => {});
    await run("git", ["worktree", "prune"], clone).catch(() => {});
    throw err;
  }
  return path;
}

export async function removeAskWorktree(clone: string, path: string): Promise<void> {
  await run("git", ["worktree", "remove", "--force", path], clone);
  await run("git", ["worktree", "prune"], clone);
  rmSync(path, { recursive: true, force: true });
}

// ── prune ─────────────────────────────────────────────────────────────

export interface PruneResult {
  removed: string[];
  kept: { clone: string; reason: string }[];
}

/** Managed clones under workspaces_dir: folders that are a git top level. */
function findClones(ws: string, depth = 0): string[] {
  if (depth > 6) return [];
  let entries;
  try {
    entries = readdirSync(ws, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((e) => e.name === ".git")) return [ws];
  return entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith("."))
    .flatMap((e) => findClones(join(ws, e.name), depth + 1));
}

/** Clones that tasks still use (any task not closed whose repo_root is the clone). */
function clonesInUse(env: NodeJS.ProcessEnv): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let names: string[] = [];
  try {
    names = readdirSync(tasksDir(env)).filter((n) => TASK_ID_RE.test(n));
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const s = readTask(name, env);
      const root = s.workspace?.repo_root;
      if (!root || s.status === "closed") continue;
      const key = existsSync(root) ? realpathSync.native(root) : root;
      out.set(key, [...(out.get(key) ?? []), s.id]);
    } catch {
      // unreadable task: ignore
    }
  }
  return out;
}

/**
 * Remove managed clones that no open task uses. Keeps a clone that still has
 * worktrees, or local commits that are on no remote branch (unpushed work
 * from `keep_branch`), unless `force`.
 */
export async function pruneWorkspaces(
  config: Config,
  env: NodeJS.ProcessEnv,
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<PruneResult> {
  const result: PruneResult = { removed: [], kept: [] };
  if (!existsSync(config.workspaces_dir)) return result;
  const ws = ensureWorkspacesDir(config);
  const inUse = clonesInUse(env);
  for (const clone of findClones(ws)) {
    await withRepoLock(clone, env, async () => {
      const users = inUse.get(clone);
      if (users) {
        result.kept.push({ clone, reason: `used by open task(s) ${users.join(", ")}` });
        return;
      }
      const wts = await run("git", ["worktree", "list", "--porcelain"], clone);
      const others = wts.stdout.split("\n").filter((l) => l.startsWith("worktree ")).length - 1;
      if (wts.code !== 0) {
        result.kept.push({ clone, reason: "git worktree list failed" });
        return;
      }
      if (others > 0) {
        result.kept.push({ clone, reason: `${others} worktree(s) still exist` });
        return;
      }
      const unpushed = await run(
        "git",
        ["rev-list", "--count", "--branches", "--not", "--remotes"],
        clone,
      );
      const count = unpushed.code === 0 ? Number(unpushed.stdout.trim()) : NaN;
      if (!opts.force && !(count === 0)) {
        result.kept.push({
          clone,
          reason: Number.isNaN(count)
            ? "could not check for unpushed commits (use --force)"
            : `${count} local commit(s) not on any remote branch (use --force)`,
        });
        return;
      }
      if (!opts.dryRun) rmSync(clone, { recursive: true, force: true });
      result.removed.push(clone);
    });
  }
  return result;
}
