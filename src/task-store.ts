/**
 * Task state on disk: `tasks/<id>/task.json` plus the per-task files the
 * runner owns. While a runner is alive it is the only writer of task.json;
 * the server writes it only to create a task or before launching a runner.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "./config.js";
import { tasksDir } from "./paths.js";

export const TASK_ID_RE = /^t[0-9a-z]{10}$/;
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "idle"
  | "stalled"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "rate_limited"
  | "closing"
  | "closed";

export type PermissionMode = "auto" | "bypassPermissions" | "plan";

/** What the runner needs to start `claude`. Limits are in milliseconds. */
export interface TaskSpec {
  workdir: string;
  profile_name: string;
  profile: Profile;
  /** Overrides the profile's mode; `ask` uses "plan" for read-only answers. */
  permission_mode?: PermissionMode;
  /** Blocked on top of the profile's `disallowed_tools`. */
  extra_disallowed_tools?: string[];
  model?: string;
  effort?: string;
  system_prompt?: string;
  output_schema?: Record<string, unknown>;
  max_turn_ms: number;
  stall_ms: number;
  idle_ms: number;
  max_event_bytes: number;
  /** How long to wait for a control-request interrupt before falling back to SIGINT. */
  interrupt_timeout_ms: number;
  /** Generated or profile settings file, passed with --settings. */
  settings_file?: string;
  /** Generated plugin folder with the profile's personal skills. */
  personal_plugin_dir?: string;
}

export interface TurnResult {
  subtype: string;
  is_error: boolean;
  text?: string;
  structured_output?: unknown;
  num_turns?: number;
  duration_ms?: number;
  usage?: unknown;
  total_cost_usd?: number;
  permission_denials?: unknown[];
}

/** Where a task works. Worktree tasks get their own branch and folder. */
export interface Workspace {
  isolation: "worktree" | "in_place";
  /** Top level of the git repo, if the task's folder is in one. */
  repo_root?: string;
  /** The task's worktree folder (worktree isolation only). */
  worktree?: string;
  branch?: string;
  /** Commit the task started from; get_diff compares against it. */
  base_commit?: string;
  /** Short title for branch names and PRs. */
  title?: string;
  /** Canonical repo_url for tasks in a managed clone (section 12.5). */
  repo_url?: string;
  /** Remote branch the task started from; the PR base for push_pr. */
  base_branch?: string;
}

export interface TaskState {
  version: 1;
  id: string;
  name?: string;
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  spec: TaskSpec;
  workspace?: Workspace;
  session_id: string;
  /** True once `claude` has created the session; later starts use --resume. */
  session_started: boolean;
  /** Messages for the next runner start, sent as the first turn. */
  pending_messages: string[];
  runner: { pid: number; started_at: string } | null;
  claude_pid: number | null;
  turns: number;
  /** When the task last entered the queue (max_concurrent or a rate-limit hold). */
  queued_at?: string;
  turn_started_at: string | null;
  last_event_at: string | null;
  events_bytes: number;
  result: TurnResult | null;
  rate_limit: unknown;
  error: string | null;
}

export class TaskNotFoundError extends Error {
  readonly code = "ENOTASK" as const;
  constructor(id: string) {
    super(`task not found: ${id}`);
    this.name = "TaskNotFoundError";
  }
}

export function assertTaskId(id: string): void {
  if (!TASK_ID_RE.test(id)) throw new TaskNotFoundError(String(id).slice(0, 64));
}

export function newTaskId(): string {
  let id = "t";
  for (const b of randomBytes(10)) id += (b % 36).toString(36);
  return id;
}

export function taskDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  assertTaskId(id);
  return join(tasksDir(env), id);
}

export const taskFiles = (id: string, env: NodeJS.ProcessEnv = process.env) => {
  const dir = taskDir(id, env);
  return {
    dir,
    task: join(dir, "task.json"),
    events: join(dir, "events.jsonl"),
    socket: join(dir, "runner.sock"),
    runnerLog: join(dir, "runner.log"),
  };
};

export function readTask(id: string, env: NodeJS.ProcessEnv = process.env): TaskState {
  const { task } = taskFiles(id, env);
  let raw: string;
  try {
    raw = readFileSync(task, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new TaskNotFoundError(id);
    throw err;
  }
  return JSON.parse(raw) as TaskState;
}

/** Atomic replace: write a temp file, then rename over task.json. */
export function writeTask(state: TaskState, env: NodeJS.ProcessEnv = process.env): void {
  const { task } = taskFiles(state.id, env);
  state.updated_at = new Date().toISOString();
  const tmp = `${task}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, task);
}

export interface NewTask {
  spec: TaskSpec;
  prompt: string;
  name?: string;
  /** Use this id (from newTaskId) instead of a fresh one. */
  id?: string;
  workspace?: Workspace;
  /**
   * Build generated files in the new task folder before task.json exists,
   * and return spec fields that point at them. If it throws, the folder is
   * removed and no task is created.
   */
  prepare?: (taskDir: string) => Partial<TaskSpec>;
}

/** Create the task folder and its first task.json. The prompt becomes the first turn. */
export function createTask(input: NewTask, env: NodeJS.ProcessEnv = process.env): TaskState {
  mkdirSync(tasksDir(env), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    const id = input.id ?? newTaskId();
    try {
      mkdirSync(taskDir(id, env), { mode: 0o700 });
    } catch (err) {
      const retry = !input.id && attempt < 5;
      if ((err as NodeJS.ErrnoException).code === "EEXIST" && retry) continue;
      throw err;
    }
    let extra: Partial<TaskSpec> = {};
    if (input.prepare) {
      try {
        extra = input.prepare(taskDir(id, env));
      } catch (err) {
        rmSync(taskDir(id, env), { recursive: true, force: true });
        throw err;
      }
    }
    const now = new Date().toISOString();
    const state: TaskState = {
      version: 1,
      id,
      ...(input.name ? { name: input.name } : {}),
      created_at: now,
      updated_at: now,
      status: "starting",
      spec: { ...input.spec, ...extra },
      ...(input.workspace ? { workspace: input.workspace } : {}),
      session_id: randomUUID(),
      session_started: false,
      pending_messages: [input.prompt],
      runner: null,
      claude_pid: null,
      turns: 0,
      turn_started_at: null,
      last_event_at: null,
      events_bytes: 0,
      result: null,
      rate_limit: null,
      error: null,
    };
    writeTask(state, env);
    return state;
  }
}
