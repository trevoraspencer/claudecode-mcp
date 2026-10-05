/**
 * Managed clones for `repo_url` tasks (DESIGN-v2 section 12.5).
 *
 * One clone per repo at `<workspaces_dir>/<scheme>_<host>/<owner>/<repo>.git`
 * (see `cloneSegments`), made with `git clone --no-checkout` on first use and
 * refreshed with `git fetch --prune` before each task. A clone is marked as
 * ours (`claudecode-mcp.managed` in its config), its HEAD is detached, and its
 * local default branch is deleted, so every local branch is task work. The
 * repo lock (`withRepoLock`, in `<workspaces_dir>/.locks`) is held around the
 * clone or fetch and the worktree that follows, and around prune.
 *
 * Trust note: tasks run as the same user and can change a clone's config.
 * The `repo_urls` allowlist decides what callers may ask for; before each
 * fetch the clone's marker and `origin` URL are checked against the request,
 * so an accidental or task-made change is refused rather than followed.
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
  statSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import {
  assertNoRemoteRewrites,
  assertRef,
  ensureWorktreeExclude,
  git,
  GitError,
  pushArgs,
  remoteConfigArgs,
  run,
} from "./git.js";
import { withRepoLock } from "./launcher.js";
import { errorLog } from "./log.js";
import { tasksDir } from "./paths.js";
import { isInside } from "./repo.js";
import { cloneSegments, parseRepoUrl, urlAllowed, type RepoUrl } from "./repo-url.js";
import { readTask, TASK_ID_RE } from "./task-store.js";

export const ALLOW_FILE_URLS_ENV = "CLAUDECODE_MCP_ALLOW_FILE_URLS";
export const MANAGED_KEY = "claudecode-mcp.managed";
const CLONE_TIMEOUT_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;
const TEMP_CLONE_PREFIX = ".clone-";
const TRASH_PREFIX = ".trash-";
const LOCKS_DIR = ".locks";
/** A temp clone older than this is left over from a crash. */
const TEMP_CLONE_STALE_MS = 2 * CLONE_TIMEOUT_MS;

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

function lockRepo<T>(ws: string, clone: string, fn: () => Promise<T>): Promise<T> {
  return withRepoLock(join(ws, LOCKS_DIR), clone, fn);
}

async function configGet(clone: string, key: string): Promise<string | undefined> {
  const r = await run("git", ["config", "--local", "--get", key], clone);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** True if `dir` is a clone this server made (top level with our marker). */
async function isManagedClone(dir: string): Promise<boolean> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], dir);
  if (top.code !== 0 || realpathSync.native(top.stdout.trim()) !== realpathSync.native(dir)) {
    return false;
  }
  return (await configGet(dir, MANAGED_KEY)) !== undefined;
}

/**
 * The clone's marker and `origin` must still name `canonical`. Checked before
 * every fetch and before `push_pr`, so a remote changed after the allowlist
 * check (by hand or by a task) is refused rather than followed.
 */
export async function assertCloneOrigin(clone: string, canonical: string): Promise<void> {
  const marker = await configGet(clone, MANAGED_KEY);
  const origin = await configGet(clone, "remote.origin.url");
  let originCanonical: string | undefined;
  try {
    originCanonical = origin ? parseRepoUrl(origin, { allowFile: true }).canonical : undefined;
  } catch {
    originCanonical = undefined;
  }
  if (marker !== canonical || originCanonical !== canonical) {
    throw new WorkspaceError(
      `managed clone ${clone} no longer points at ${canonical} ` +
        `(origin: ${(origin ?? "none").slice(0, 200)}); fix remote.origin.url or remove the clone`,
    );
  }
}

/**
 * Clone or fetch. Call only under the repo lock. A new clone is made in a
 * temp folder, marked, detached from its default branch, and then renamed
 * into place, so a failed clone leaves nothing.
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
    if (!(await isManagedClone(clone))) {
      throw new WorkspaceError(`${clone} exists but is not a managed clone; remove it`);
    }
    await assertCloneOrigin(clone, url.canonical);
    await assertNoRemoteRewrites(clone);
    const remote = { env: remoteEnv(env), timeoutMs: FETCH_TIMEOUT_MS, keepTokens: true };
    await git(
      [...remoteConfigArgs(env), "fetch", "--prune", "--no-recurse-submodules", "origin"],
      clone,
      remote,
    );
    // Follow a changed default branch; a failure keeps the old origin/HEAD.
    await run(
      "git",
      [...remoteConfigArgs(env), "remote", "set-head", "origin", "--auto"],
      clone,
      remote,
    ).catch(() => {});
    return "fetched";
  }
  const tmp = join(parent, `${TEMP_CLONE_PREFIX}${randomBytes(6).toString("hex")}`);
  try {
    await git(
      [
        ...remoteConfigArgs(env),
        "clone",
        "--no-checkout",
        "--no-recurse-submodules",
        "--",
        url.cloneUrl,
        tmp,
      ],
      parent,
      { env: remoteEnv(env), timeoutMs: CLONE_TIMEOUT_MS, keepTokens: true },
    );
    await git(["config", "--local", MANAGED_KEY, url.canonical], tmp);
    // Detach HEAD and drop the local default branch: it would never be
    // updated, and every remaining local branch is then task work.
    const branch = await run("git", ["symbolic-ref", "-q", "--short", "HEAD"], tmp);
    const head = await run("git", ["rev-parse", "--verify", "-q", "HEAD"], tmp);
    if (head.code === 0) {
      await git(["update-ref", "--no-deref", "HEAD", head.stdout.trim()], tmp);
      if (branch.code === 0 && branch.stdout.trim()) {
        await git(["branch", "-D", "--", branch.stdout.trim()], tmp);
      }
    }
    renameSync(tmp, clone);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return "cloned";
}

/**
 * The commit to start from, and the remote branch it came from (the PR base
 * for `push_pr`). Default: the remote's default branch (`origin/HEAD`). A
 * branch name means the remote branch (`origin/<name>`); tags and commits
 * work as given and have no branch.
 */
export async function resolveRemoteBase(
  clone: string,
  baseRef?: string,
): Promise<{ sha: string; branch?: string }> {
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
    if (!head) {
      throw new WorkspaceError("the remote has no default branch (origin/HEAD); pass base_ref");
    }
    const sym = await run("git", ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], clone);
    const name = sym.stdout.trim().replace(/^refs\/remotes\/origin\//, "");
    return sym.code === 0 && name && name !== sym.stdout.trim()
      ? { sha: head, branch: name }
      : { sha: head };
  }
  if (baseRef === "HEAD") return resolveRemoteBase(clone);
  assertRef(baseRef);
  // Only an exact remote branch name is a PR base (not `main~1` or `main^`).
  const exact = await run(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${baseRef}`],
    clone,
  );
  const remote = exact.code === 0 ? await tryRef(`refs/remotes/origin/${baseRef}`) : undefined;
  if (remote) return { sha: remote, branch: baseRef };
  const expr = await tryRef(`refs/remotes/origin/${baseRef}`);
  if (expr) return { sha: expr };
  for (const ref of [`refs/tags/${baseRef}`, baseRef]) {
    const sha = await tryRef(ref);
    if (sha) return { sha };
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
  return lockRepo(ws, clone, async () => {
    await syncClone(url, clone, ws, env);
    return fn(clone);
  });
}

/**
 * Push a task branch from a managed clone, under the repo lock: re-check the
 * clone's marker and origin, refuse remote rewrites, then push to the
 * verified origin URL given explicitly, with hooks off and the server token
 * only for gh's credential helper.
 */
export async function pushManagedBranch(
  config: Config,
  env: NodeJS.ProcessEnv,
  clone: string,
  canonical: string,
  branch: string,
): Promise<void> {
  const ws = ensureWorkspacesDir(config);
  await lockRepo(ws, clone, async () => {
    await assertCloneOrigin(clone, canonical);
    await assertNoRemoteRewrites(clone);
    const url = (await configGet(clone, "remote.origin.url"))!;
    await git(pushArgs(branch, url, env), clone, {
      env: remoteEnv(env),
      timeoutMs: 120_000,
      keepTokens: true,
    });
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

/** Remove an `ask` worktree under the repo lock. */
export async function removeAskWorktree(config: Config, clone: string, path: string) {
  const ws = ensureWorkspacesDir(config);
  await lockRepo(ws, clone, async () => {
    await run("git", ["worktree", "remove", "--force", path], clone);
    await run("git", ["worktree", "prune"], clone);
    rmSync(path, { recursive: true, force: true });
  });
}

// ── prune ─────────────────────────────────────────────────────────────

export interface PruneResult {
  removed: string[];
  kept: { clone: string; reason: string }[];
}

/**
 * Candidate clones under workspaces_dir: folders named `*.git` that hold a
 * `.git` (the layout `cloneSegments` makes). Also clears temp clones left by
 * a crash. Never follows symlinks.
 */
function findClones(dir: string, depth: number, out: string[], dryRun: boolean): void {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const path = join(dir, e.name);
    if (e.name.startsWith(TEMP_CLONE_PREFIX)) {
      try {
        if (!dryRun && Date.now() - statSync(path).mtimeMs > TEMP_CLONE_STALE_MS) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        // gone
      }
      continue;
    }
    if (e.name === LOCKS_DIR || e.name.startsWith(TRASH_PREFIX)) continue;
    if (e.name.endsWith(".git") && existsSync(join(path, ".git"))) {
      out.push(path);
      continue;
    }
    findClones(path, depth + 1, out, dryRun);
  }
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

/** Why a managed clone must be kept, or undefined if it can go. */
async function keepReason(clone: string, force: boolean): Promise<string | undefined> {
  // Forget worktrees whose folders are gone, then count the rest.
  await run("git", ["worktree", "prune"], clone);
  const wts = await run("git", ["worktree", "list", "--porcelain"], clone);
  if (wts.code !== 0) return "git worktree list failed";
  const others = wts.stdout.split("\n").filter((l) => l.startsWith("worktree ")).length - 1;
  if (others > 0) return `${others} worktree(s) still exist`;
  if (force) return undefined;
  const unpushed = await run(
    "git",
    ["rev-list", "--count", "--branches", "--not", "--remotes"],
    clone,
  );
  const count = unpushed.code === 0 ? Number(unpushed.stdout.trim()) : NaN;
  if (Number.isNaN(count)) return "could not check for unpushed commits (use --force)";
  if (count > 0) return `${count} local commit(s) not on any remote branch (use --force)`;
  const stash = await run("git", ["rev-parse", "--verify", "-q", "refs/stash"], clone);
  if (stash.code === 0) return "has a git stash (use --force)";
  // The clone has no checkout; files in its folder were put there by hand.
  const untracked = await run(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--directory", "-z", "--", ":!.claude"],
    clone,
  );
  if (untracked.code !== 0 || untracked.stdout.length > 0) {
    return "has files in its folder (use --force)";
  }
  return undefined;
}

/**
 * Remove managed clones that no open task uses. Only folders this server made
 * (marker in their config) are touched. Keeps a clone that still has
 * worktrees; without `force` also one with local commits on no remote
 * branch, a stash, or loose files. Removal renames the clone aside under the
 * lock, then deletes it after the lock is released.
 */
export async function pruneWorkspaces(
  config: Config,
  env: NodeJS.ProcessEnv,
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<PruneResult> {
  const result: PruneResult = { removed: [], kept: [] };
  if (!existsSync(config.workspaces_dir)) return result;
  const ws = ensureWorkspacesDir(config);
  if (!opts.dryRun) {
    for (const e of readdirSync(ws)) {
      if (e.startsWith(TRASH_PREFIX)) await rm(join(ws, e), { recursive: true, force: true });
    }
  }
  const inUse = clonesInUse(env);
  const candidates: string[] = [];
  findClones(ws, 0, candidates, opts.dryRun === true);
  for (const clone of candidates) {
    const trash = await lockRepo(ws, clone, async () => {
      if (!(await isManagedClone(clone))) {
        result.kept.push({ clone, reason: "not made by claudecode-mcp; left alone" });
        return undefined;
      }
      const users = inUse.get(clone);
      if (users) {
        result.kept.push({ clone, reason: `used by open task(s) ${users.join(", ")}` });
        return undefined;
      }
      const reason = await keepReason(clone, opts.force === true);
      if (reason) {
        result.kept.push({ clone, reason });
        return undefined;
      }
      result.removed.push(clone);
      if (opts.dryRun) return undefined;
      const aside = join(ws, `${TRASH_PREFIX}${randomBytes(6).toString("hex")}`);
      renameSync(clone, aside);
      return aside;
    });
    if (trash) {
      await rm(trash, { recursive: true, force: true }).catch((err: Error) =>
        errorLog({ phase: "prune", dir: trash, error: err.message }),
      );
    }
  }
  return result;
}
