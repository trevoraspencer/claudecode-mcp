/**
 * The task operations behind the MCP tools. Stateless: everything comes
 * from task.json and the runners, so a restarted server sees the same tasks.
 */

import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkClaudeVersion } from "./claude-cli.js";
import { cap, readEventsPage, recentSteps, type EventsPage, type Step } from "./compact.js";
import type { Config } from "./config.js";
import { assertDepthAllowsTasks } from "./depth.js";
import {
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
import { isInside, resolveRepo } from "./repo.js";
import type { Delivery } from "./runner.js";
import {
  createTask,
  readTask,
  TASK_ID_RE,
  taskFiles,
  writeTask,
  type TaskState,
  type TaskStatus,
} from "./task-store.js";

/** A turn is in progress (or about to be): waiting makes sense. */
const BUSY = new Set<TaskStatus>(["starting", "running", "stalled"]);
/** Finished for good unless a message resumes it. */
const ENDED = new Set<TaskStatus>(["failed", "timed_out", "cancelled", "closed"]);

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

const runnerAlive = (s: TaskState): boolean => hasLiveRunner(s);

/** Status as callers should see it: a dead runner that did not clean up is "interrupted". */
function effectiveStatus(s: TaskState): TaskStatus {
  if (s.runner !== null && !hasLiveRunner(s) && !ENDED.has(s.status)) return "interrupted";
  return s.status;
}

/** The socket is gone or refuses: the runner is dead even if its PID was reused. */
function deadSocket(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
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
      takeover: {
        command: `cd ${shellQuote(s.spec.workdir)} && claude --resume ${s.session_id}`,
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
    const workdir = resolveRepo(input.repo, this.config.allowed_roots);
    assertSocketPathFits(this.env);
    await this.ensureCli();
    const spec = buildSpec(this.config, { ...input, workdir } satisfies SpecInput);
    const state = createTask({ spec, prompt: input.prompt, name: input.name }, this.env);
    await withLaunchLock(state.id, this.env, () => launchRunner(state.id, this.env));
    return this.view(state.id, 5);
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
      if (s.status === "closed") throw new ToolError(`task ${id} is closed`);
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
      const taskId = createTask({ spec, prompt: input.prompt, name: "ask" }, this.env).id;
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
