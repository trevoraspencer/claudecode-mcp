/**
 * The task operations behind the MCP tools. Stateless: everything comes
 * from task.json and the runners, so a restarted server sees the same tasks.
 */

import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkClaudeAuth, checkClaudeVersion } from "./claude-cli.js";
import { materializeProfile } from "./profile.js";
import { cap, readEventsPage, recentSteps, type EventsPage, type Step } from "./compact.js";
import { taskDiff, type DiffResult } from "./diff.js";
import {
  createWorktree,
  currentBranch,
  dirtyFiles,
  ignoredPaths,
  nestedWorktrees,
  ghBin,
  git,
  removeWorktree,
  repoTop,
  run,
  type NewWorktree,
} from "./git.js";
import type { Config } from "./config.js";
import { assertDepthAllowsTasks } from "./depth.js";
import {
  RUNNER_CLOSED,
  assertSocketPathFits,
  buildSpec,
  hasLiveRunner,
  launchRunner,
  requestRunner,
  resumeTask,
  waitForLaunch,
  withLaunchLock,
  type SpecInput,
} from "./launcher.js";
import { errorLog } from "./log.js";
import { expandHome, tasksDir } from "./paths.js";
import { redactSecrets } from "./redaction.js";
import { isInside, resolveRepo } from "./repo.js";
import type { Delivery } from "./runner.js";
import {
  createTask,
  newTaskId,
  readTask,
  TASK_ID_RE,
  taskFiles,
  writeTask,
  type TaskSpec,
  type TaskState,
  type TaskStatus,
  type Workspace,
} from "./task-store.js";

/** A turn is in progress (or about to be): waiting makes sense. */
const BUSY = new Set<TaskStatus>(["starting", "running", "stalled"]);
/** Finished for good unless a message resumes it. */
const ENDED = new Set<TaskStatus>(["failed", "timed_out", "cancelled", "closing", "closed"]);

export const WAIT_MAX_S = 50;
export const ASK_MAX_S = 600;
const POLL_MS = 250;
const RESULT_TEXT_MAX = 20_000;
const DENIALS_MAX = 20;
const DENIAL_JSON_MAX = 2_000;
const STRUCTURED_JSON_MAX = 100_000;
const PROGRESS_EVERY_MS = 10_000;

const READ_ONLY_PROMPT =
  "This is a read-only request. Do not create, modify, or delete files, and do not run " +
  "commands that change state. Do not write a plan file. Give your full answer in your final message.";

/** An error whose message is safe and useful to show the caller. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface TaskView {
  task_id: string;
  name?: string;
  status: TaskStatus;
  runner_alive: boolean;
  workdir: string;
  session_id: string;
  profile: string;
  model?: string;
  effort?: string;
  turns: number;
  created_at: string;
  updated_at: string;
  turn_started_at: string | null;
  last_event_at: string | null;
  pending_messages: number;
  result: Record<string, unknown> | null;
  rate_limit: unknown;
  error: string | null;
  recent: Step[];
  workspace: Workspace;
  takeover: { command: string; note?: string };
}

export interface TaskSummary {
  task_id: string;
  name?: string;
  status: TaskStatus;
  workdir: string;
  profile: string;
  turns: number;
  created_at: string;
  updated_at: string;
  result_preview?: string;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A command a person can paste to continue the session by hand, with the
 * profile's Claude home, settings, and plugins so the session is found and
 * its rules still apply.
 */
function takeoverCommand(s: TaskState): string {
  const p = s.spec.profile;
  const prefix = p.config_dir ? `CLAUDE_CONFIG_DIR=${shellQuote(p.config_dir)} ` : "";
  const flags: string[] = [];
  if (s.spec.settings_file) flags.push("--settings", shellQuote(s.spec.settings_file));
  for (const dir of [
    ...p.plugin_dirs,
    ...(s.spec.personal_plugin_dir ? [s.spec.personal_plugin_dir] : []),
  ]) {
    flags.push("--plugin-dir", shellQuote(dir));
  }
  const tail = flags.length > 0 ? " " + flags.join(" ") : "";
  return `cd ${shellQuote(s.spec.workdir)} && ${prefix}claude --resume ${s.session_id}${tail}`;
}

const runnerAlive = (s: TaskState): boolean => hasLiveRunner(s);

/** Status as callers should see it: a dead runner that did not clean up is "interrupted". */
function effectiveStatus(s: TaskState): TaskStatus {
  if (s.runner !== null && !hasLiveRunner(s) && !ENDED.has(s.status)) return "interrupted";
  return s.status;
}

/**
 * The runner is gone or going: its socket is missing, refuses, resets, or
 * closes without an answer (it was shutting down, so it did not act on the
 * request). Treat it as dead even if its PID was reused. Callers that then
 * resume do so under the launch lock, which probes the socket again first.
 */
function deadSocket(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === RUNNER_CLOSED
  );
}

/** Bound the parts of a result that can be large, and say so when cut. */
function boundedResult(r: NonNullable<TaskState["result"]>): Record<string, unknown> {
  const { text, permission_denials, structured_output, ...rest } = r;
  const out: Record<string, unknown> = { ...rest };
  if (text !== undefined) {
    out.text = text.length > RESULT_TEXT_MAX ? text.slice(0, RESULT_TEXT_MAX) : text;
    if (text.length > RESULT_TEXT_MAX) {
      out.text_truncated = true;
      out.text_full_length = text.length;
    }
  }
  if (structured_output !== undefined) {
    const json = JSON.stringify(structured_output) ?? "null";
    if (json.length > STRUCTURED_JSON_MAX) {
      out.structured_output_truncated = true;
      out.structured_output_preview = json.slice(0, STRUCTURED_JSON_MAX);
    } else {
      out.structured_output = structured_output;
    }
  }
  if (permission_denials) {
    out.permission_denials = permission_denials.slice(0, DENIALS_MAX).map((d) => {
      const json = JSON.stringify(d) ?? "null";
      return json.length > DENIAL_JSON_MAX ? { truncated: cap(json, DENIAL_JSON_MAX) } : d;
    });
    if (permission_denials.length > DENIALS_MAX) {
      out.permission_denials_total = permission_denials.length;
    }
  }
  return out;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export interface StartInput {
  prompt: string;
  repo: string;
  isolation?: "worktree" | "in_place";
  base_ref?: string;
  profile?: string;
  model?: string;
  effort?: string;
  system_prompt?: string;
  output_schema?: Record<string, unknown>;
  max_minutes?: number;
  name?: string;
}

export interface AskInput {
  prompt: string;
  repo?: string;
  profile?: string;
  model?: string;
  effort?: string;
  timeout_s?: number;
  writable?: boolean;
}

export interface CloseResult {
  task: TaskView;
  removed?: string;
  branch_deleted?: string;
  pushed?: string;
  pr_url?: string;
  notes: string[];
}

export type Progress = (elapsedS: number, totalS: number, message: string) => void;

export class TaskService {
  private cliCheck: Promise<string> | null = null;

  constructor(
    private readonly config: Config,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private guard(): void {
    assertDepthAllowsTasks(this.env);
  }

  /** Check the CLI version once per server; retry after a failure. */
  private ensureCli(): Promise<string> {
    if (!this.cliCheck) {
      this.cliCheck = checkClaudeVersion(this.env);
      this.cliCheck.catch(() => (this.cliCheck = null));
    }
    return this.cliCheck;
  }

  private read(id: string): TaskState {
    if (!TASK_ID_RE.test(id)) throw new ToolError(`task not found: ${cap(String(id), 64)}`);
    try {
      return readTask(id, this.env);
    } catch {
      throw new ToolError(`task not found: ${id}`);
    }
  }

  view(id: string, recent = 10): TaskView {
    this.guard();
    const s = this.read(id);
    const alive = runnerAlive(s);
    const result = s.result ? boundedResult(s.result) : null;
    return {
      task_id: s.id,
      ...(s.name ? { name: s.name } : {}),
      status: effectiveStatus(s),
      runner_alive: alive,
      workdir: s.spec.workdir,
      session_id: s.session_id,
      profile: s.spec.profile_name,
      ...((s.spec.model ?? s.spec.profile.model)
        ? { model: s.spec.model ?? s.spec.profile.model }
        : {}),
      ...((s.spec.effort ?? s.spec.profile.effort)
        ? { effort: s.spec.effort ?? s.spec.profile.effort }
        : {}),
      turns: s.turns,
      created_at: s.created_at,
      updated_at: s.updated_at,
      turn_started_at: s.turn_started_at,
      last_event_at: s.last_event_at,
      pending_messages: s.pending_messages.length,
      result,
      rate_limit: s.rate_limit,
      error: s.error,
      recent: recentSteps(taskFiles(s.id, this.env).events, recent),
      workspace: s.workspace ?? { isolation: "in_place" },
      takeover: {
        command: takeoverCommand(s),
        ...(alive
          ? {
              note: "the runner is active: cancel_task first so two processes never drive one session",
            }
          : {}),
      },
    };
  }

  async startTask(input: StartInput): Promise<TaskView> {
    this.guard();
    const repo = resolveRepo(input.repo, this.config.allowed_roots);
    const isolation = input.isolation ?? "worktree";
    if (isolation === "in_place" && input.base_ref) {
      throw new ToolError('base_ref needs isolation: "worktree"');
    }
    assertSocketPathFits(this.env);
    await this.ensureCli();
    const { prompt, name, isolation: _i, base_ref: _b, repo: _r, ...rest } = input;
    const id = newTaskId();
    // The title becomes a branch name and maybe a PR title: redact it.
    const title = cap(redactSecrets(name ?? prompt.split("\n")[0] ?? "task"), 70);
    let workspace: Workspace;
    let wt: NewWorktree | undefined;
    if (isolation === "worktree") {
      const top = await repoTop(repo);
      if (!top) throw new ToolError(`not a git repository: ${repo}; pass isolation: "in_place"`);
      // The worktree mirrors the whole repo, so the repo's top level must be
      // inside allowed_roots too (not just the folder the caller named).
      const realTop = realpathSync.native(top);
      if (
        !this.config.allowed_roots.some(
          (r) => existsSync(r) && isInside(realTop, realpathSync.native(r)),
        )
      ) {
        throw new ToolError(
          `the git repo containing ${repo} (${top}) is outside allowed_roots; pass isolation: "in_place"`,
        );
      }
      wt = await createWorktree({ repo, top, taskId: id, baseRef: input.base_ref, title });
      workspace = {
        isolation,
        repo_root: wt.repo_root,
        worktree: wt.worktree,
        branch: wt.branch,
        base_commit: wt.base_commit,
        title,
      };
    } else {
      const top = await repoTop(repo);
      // A repo with no commits yet has no base; get_diff then says so.
      const head = top ? await run("git", ["rev-parse", "--verify", "-q", "HEAD"], top) : null;
      workspace = top
        ? {
            isolation,
            repo_root: top,
            ...(head?.code === 0 ? { base_commit: head.stdout.trim() } : {}),
            title,
          }
        : { isolation, title };
    }
    try {
      const spec = buildSpec(this.config, {
        ...rest,
        workdir: wt?.workdir ?? repo,
      } satisfies SpecInput);
      await this.checkProfileAuth(spec);
      createTask({ id, spec, prompt, name, workspace, prepare: this.profileFiles(spec) }, this.env);
    } catch (err) {
      // Nothing ran yet: do not leave an orphan worktree or branch behind.
      // (createTask removes its own folder when preparing fails.)
      if (wt) {
        await removeWorktree(wt.repo_root, wt.worktree, true).catch(() => {});
        await git(["branch", "-D", wt.branch], wt.repo_root).catch(() => {});
      }
      throw err;
    }
    await withLaunchLock(id, this.env, () => launchRunner(id, this.env));
    return this.view(id, 5);
  }

  /** createTask hook: build the generated profile files before task.json exists. */
  private profileFiles(spec: TaskSpec): (taskDir: string) => Partial<TaskSpec> {
    return (taskDir) => materializeProfile(spec.profile_name, spec.profile, taskDir, this.env);
  }

  /** A profile with its own Claude home needs its own login there. */
  private async checkProfileAuth(spec: TaskSpec): Promise<void> {
    const dir = spec.profile.config_dir;
    if (!dir) return;
    // Same env the runner gives claude: the profile's env may hold the token.
    if (!(await checkClaudeAuth(this.env, { ...spec.profile.env, CLAUDE_CONFIG_DIR: dir }))) {
      throw new ToolError(
        `profile "${spec.profile_name}" uses config_dir ${dir}, which is not logged in. ` +
          `Run: CLAUDE_CONFIG_DIR=${dir} claude auth login (or set CLAUDE_CODE_OAUTH_TOKEN from claude setup-token)`,
      );
    }
  }

  /** What the task changed since its base commit. */
  async getDiff(id: string, statOnly: boolean): Promise<DiffResult> {
    this.guard();
    const s = this.read(id);
    const ws = s.workspace;
    const dir = ws?.worktree ?? ws?.repo_root;
    if (!dir) throw new ToolError(`task ${id} is not in a git repo`);
    if (!ws?.base_commit) {
      throw new ToolError(`task ${id} has no base commit (its repo had no commits at start)`);
    }
    if (s.status === "closed" && ws.worktree) {
      // The folder is gone; the branch still holds any commits.
      throw new ToolError(`task ${id} is closed; its worktree was removed (branch ${ws.branch})`);
    }
    if (!existsSync(dir)) throw new ToolError(`task ${id}'s folder is missing: ${dir}`);
    return taskDiff(dir, ws.base_commit, statOnly, ws.branch);
  }

  /**
   * Finish a task: stop its runner, then keep the branch (remove the
   * worktree folder), delete both, or push the branch and open a draft PR.
   */
  async closeTask(
    id: string,
    action: "keep_branch" | "delete" | "push_pr" = "keep_branch",
    force = false,
  ): Promise<CloseResult> {
    this.guard();
    this.read(id);
    // Hold the launch lock throughout, so no message can resume the task
    // (and start claude in the worktree) while it is being closed.
    return withLaunchLock(id, this.env, () => this.closeLocked(id, action, force));
  }

  private async closeLocked(
    id: string,
    action: "keep_branch" | "delete" | "push_pr",
    force: boolean,
  ): Promise<CloseResult> {
    const notes: string[] = [];
    let s = this.read(id);
    if (s.status === "closed") return { task: this.view(id, 0), notes: ["already closed"] };
    const ws = s.workspace;
    const wt = ws?.isolation === "worktree" ? ws : undefined;
    if (!wt && action !== "keep_branch") {
      throw new ToolError(`task ${id} has no worktree; only action "keep_branch" applies`);
    }
    if (runnerAlive(s)) {
      try {
        await requestRunner(id, { op: "cancel" }, this.env, 20_000);
      } catch (err) {
        if (!deadSocket(err)) throw err;
        s = this.read(id);
        s.runner = null;
        s.claude_pid = null;
        writeTask(s, this.env);
      }
    }
    s = this.read(id);
    if (runnerAlive(s)) throw new ToolError(`task ${id} is still running; try again`);
    const out: Omit<CloseResult, "task" | "notes"> = {};
    if (wt?.worktree && wt.repo_root && wt.branch) {
      const { repo_root: root, worktree, branch } = wt;
      // A worktree has a .git file; checking with git would also succeed
      // from the parent repo if the folder were no longer a worktree.
      const exists = existsSync(join(worktree, ".git"));
      if (!exists) await run("git", ["worktree", "prune"], root).catch(() => {});

      // ── checks first: nothing below may change state until they pass ──
      if (exists) {
        const nested = await nestedWorktrees(root, worktree);
        if (nested.length > 0) {
          throw new ToolError(
            `task ${id}'s folder contains other worktrees (${nested.join(", ")}); close those tasks first`,
          );
        }
        if (!force) {
          const dirty = await dirtyFiles(worktree);
          if (dirty.length > 0) {
            throw new ToolError(
              `task ${id} has uncommitted changes (${dirty.length} files: ${dirty.slice(0, 20).join(", ")}). ` +
                "Ask Claude to commit them, or pass force: true to discard them.",
            );
          }
          const head = await currentBranch(worktree);
          if (head !== branch) {
            throw new ToolError(
              `task ${id}'s worktree is on ${head ? `branch ${head}` : "a detached HEAD"}, not ${branch}; ` +
                "commits made there would be lost. Ask Claude to move them to the task branch, or pass force: true.",
            );
          }
        }
      }
      if (action === "delete" && !force) {
        const ahead = (await git(["rev-list", "--count", `HEAD..${branch}`], root)).trim();
        if (ahead !== "0") {
          throw new ToolError(
            `branch ${branch} has ${ahead} commit(s) not in the repo's HEAD; ` +
              "merge them, use keep_branch, or pass force: true to delete them",
          );
        }
      }
      const ignored = exists ? await ignoredPaths(worktree) : [];

      // Mark the task as closing before any slow step, so it can never be
      // resumed into a folder that is going away, even if a step fails.
      s = this.read(id);
      s.status = "closing";
      writeTask(s, this.env);

      if (action === "push_pr") {
        try {
          await git(["push", "-u", "origin", branch], exists ? worktree : root, {
            env: this.env,
            timeoutMs: 120_000,
          });
        } catch (err) {
          throw new ToolError(
            `push failed: ${(err as Error).message}. The task is "closing"; fix the remote and call close_task again.`,
          );
        }
        out.pushed = branch;
        const pr = await this.openDraftPr(s, branch, exists ? worktree : root);
        if ("url" in pr) out.pr_url = pr.url;
        else notes.push(pr.note);
      }
      if (exists) {
        await removeWorktree(root, worktree, force);
        out.removed = worktree;
        if (ignored.length > 0) {
          notes.push(
            `removed ${ignored.length} ignored path(s) with the worktree: ${ignored.slice(0, 20).join(", ")}`,
          );
        }
      }
      if (action === "delete") {
        await git(["branch", "-D", branch], root);
        out.branch_deleted = branch;
      }
    }
    s = this.read(id);
    s.status = "closed";
    writeTask(s, this.env);
    return { task: this.view(id, 0), ...out, notes };
  }

  private async openDraftPr(
    s: TaskState,
    branch: string,
    cwd: string,
  ): Promise<{ url: string } | { note: string }> {
    // Title and body go to the remote: redact them like any client output.
    const secrets = Object.values(s.spec.profile.env);
    const title = redactSecrets(
      s.workspace?.title ?? s.name ?? `claudecode-mcp task ${s.id}`,
      secrets,
    );
    const summary = s.result?.text
      ? `\n\n${redactSecrets(cap(s.result.text, 5_000), secrets)}`
      : "";
    const body = `Opened by claudecode-mcp from task \`${s.id}\`.${summary}`;
    let r;
    try {
      r = await run(
        ghBin(this.env),
        // --flag=value, so a title starting with "-" is never read as a flag.
        ["pr", "create", "--draft", `--head=${branch}`, `--title=${title}`, `--body=${body}`],
        cwd,
        { env: this.env, timeoutMs: 60_000 },
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { note: "gh is not installed; branch pushed, open the PR yourself" };
      }
      return {
        note: `gh pr create did not finish (${(err as Error).message}); check for a PR before retrying`,
      };
    }
    if (r.code !== 0) {
      return { note: `gh pr create failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}` };
    }
    const url = r.stdout.trim().split("\n").at(-1) ?? "";
    return url ? { url } : { note: "gh did not print a PR URL" };
  }

  /** Wait until the task is no longer busy, up to `timeoutS`. */
  async waitTask(
    id: string,
    timeoutS: number,
    recent = 10,
    signal?: AbortSignal,
  ): Promise<TaskView & { wait_timed_out: boolean }> {
    this.guard();
    const deadline = Date.now() + Math.min(timeoutS, WAIT_MAX_S) * 1000;
    for (;;) {
      const s = this.read(id);
      const busy = BUSY.has(effectiveStatus(s));
      if (!busy || Date.now() >= deadline || signal?.aborted) {
        return { ...this.view(id, recent), wait_timed_out: busy };
      }
      await sleep(POLL_MS, signal);
    }
  }

  getEvents(id: string, cursor: number, limit: number): EventsPage {
    this.guard();
    this.read(id);
    return readEventsPage(taskFiles(id, this.env).events, cursor, limit);
  }

  async sendMessage(
    id: string,
    text: string,
    interrupt: boolean,
  ): Promise<{ delivery: Delivery | "resumed"; task: TaskView }> {
    this.guard();
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = this.read(id);
      if (s.status === "closed" || s.status === "closing") {
        throw new ToolError(`task ${id} is ${s.status}`);
      }
      if (runnerAlive(s)) {
        try {
          const r = await requestRunner(id, { op: "message", text, interrupt }, this.env);
          if (!r.ok) throw new ToolError(r.error);
          return { delivery: r.delivery ?? "delivered", task: this.view(id, 5) };
        } catch (err) {
          // A missing or refusing socket means the runner is gone (it may
          // have just exited, or its PID was reused): resume instead.
          if (!deadSocket(err)) throw err;
        }
      }
      await this.ensureCli();
      // resumeTask serializes launches; if another caller started a runner
      // first, loop and deliver over its socket instead.
      if ((await resumeTask(id, text, this.env)) === "resumed") {
        return { delivery: "resumed", task: this.view(id, 5) };
      }
    }
    throw new ToolError(`could not deliver the message to task ${id}; try again`);
  }

  async cancelTask(id: string): Promise<TaskView> {
    this.guard();
    this.read(id);
    // A runner being launched right now gets its cancel over the socket.
    await waitForLaunch(id, this.env);
    const s = this.read(id);
    let dead = !runnerAlive(s);
    if (!dead) {
      try {
        await requestRunner(id, { op: "cancel" }, this.env, 20_000);
      } catch (err) {
        dead = deadSocket(err);
        if (!dead) throw err;
      }
    }
    if (dead) {
      const fresh = this.read(id);
      if (!ENDED.has(fresh.status) || fresh.runner !== null) {
        if (!ENDED.has(fresh.status)) fresh.status = "cancelled";
        fresh.runner = null;
        fresh.claude_pid = null;
        writeTask(fresh, this.env);
      }
    }
    return this.view(id, 5);
  }

  listTasks(filter: { status?: TaskStatus; repo?: string; limit?: number }): TaskSummary[] {
    this.guard();
    let names: string[];
    try {
      names = readdirSync(tasksDir(this.env)).filter((n) => TASK_ID_RE.test(n));
    } catch {
      return [];
    }
    let repo: string | undefined;
    if (filter.repo) {
      try {
        repo = realpathSync.native(expandHome(filter.repo));
      } catch {
        return [];
      }
    }
    const out: TaskSummary[] = [];
    for (const name of names) {
      let s: TaskState;
      try {
        s = readTask(name, this.env);
      } catch {
        continue;
      }
      const status = effectiveStatus(s);
      if (filter.status && status !== filter.status) continue;
      if (repo && !isInside(s.spec.workdir, repo)) continue;
      out.push({
        task_id: s.id,
        ...(s.name ? { name: s.name } : {}),
        status,
        workdir: s.spec.workdir,
        profile: s.spec.profile_name,
        turns: s.turns,
        created_at: s.created_at,
        updated_at: s.updated_at,
        ...(s.result?.text ? { result_preview: cap(s.result.text, 200) } : {}),
      });
    }
    out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return out.slice(0, filter.limit ?? 50);
  }

  /**
   * Blocking question: run one turn, return the answer, close the task.
   * Read-only by default (plan mode, file-writing tools blocked).
   */
  async ask(input: AskInput, signal?: AbortSignal, progress?: Progress): Promise<string> {
    this.guard();
    const timeoutS = Math.min(input.timeout_s ?? 300, ASK_MAX_S);
    let tempDir: string | undefined;
    let workdir: string;
    if (input.repo) {
      workdir = resolveRepo(input.repo, this.config.allowed_roots);
    } else {
      tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), "claudecode-mcp-ask-")));
      workdir = tempDir;
    }
    let id: string | undefined;
    try {
      assertSocketPathFits(this.env);
      await this.ensureCli();
      const readOnly = input.writable !== true;
      const spec = buildSpec(this.config, {
        workdir,
        profile: input.profile,
        model: input.model,
        effort: input.effort,
        max_minutes: Math.ceil(timeoutS / 60),
        ...(readOnly ? { system_prompt: READ_ONLY_PROMPT } : {}),
      });
      if (readOnly) {
        spec.permission_mode = "plan";
        spec.extra_disallowed_tools = ["Edit", "Write", "NotebookEdit"];
      }
      await this.checkProfileAuth(spec);
      const taskId = createTask(
        { spec, prompt: input.prompt, name: "ask", prepare: this.profileFiles(spec) },
        this.env,
      ).id;
      id = taskId;
      await withLaunchLock(taskId, this.env, () => launchRunner(taskId, this.env));
      const started = Date.now();
      const deadline = started + timeoutS * 1000;
      let nextProgress = started + PROGRESS_EVERY_MS;
      for (;;) {
        const status = effectiveStatus(this.read(id));
        if (!BUSY.has(status)) break;
        if (signal?.aborted) throw new ToolError(`ask was cancelled (task ${id})`);
        if (Date.now() >= deadline) {
          throw new ToolError(`ask timed out after ${timeoutS} s (task ${id})`);
        }
        if (progress && Date.now() >= nextProgress) {
          const elapsed = Math.round((Date.now() - started) / 1000);
          progress(elapsed, timeoutS, `waiting for claude (${elapsed} s)`);
          nextProgress += PROGRESS_EVERY_MS;
        }
        await sleep(POLL_MS, signal);
      }
      const s = this.read(id);
      if (s.result && !s.result.is_error && s.status === "idle") {
        if (s.result.structured_output !== undefined) {
          return JSON.stringify(s.result.structured_output, null, 2);
        }
        return s.result.text ?? "";
      }
      throw new ToolError(s.error ?? `ask failed (${s.result?.subtype ?? s.status}) (task ${id})`);
    } finally {
      const stopped = id ? await this.closeQuietly(id) : true;
      // Never delete the folder under a claude that is still running.
      if (tempDir && stopped) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch (err) {
          errorLog({ phase: "ask_cleanup", dir: tempDir, error: (err as Error).message });
        }
      }
    }
  }

  /**
   * Stop the runner if needed and mark the task closed, keeping its record.
   * Returns false if the runner is still alive afterwards.
   */
  private async closeQuietly(id: string): Promise<boolean> {
    try {
      await waitForLaunch(id, this.env);
      if (runnerAlive(readTask(id, this.env))) {
        await requestRunner(id, { op: "cancel" }, this.env, 20_000).catch(() => {});
      }
      const s = readTask(id, this.env);
      if (runnerAlive(s)) return false;
      s.status = "closed";
      writeTask(s, this.env);
      return true;
    } catch {
      return false;
    }
  }
}
