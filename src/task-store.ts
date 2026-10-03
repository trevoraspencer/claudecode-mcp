/**
 * Task state on disk: `tasks/<id>/task.json` plus the per-task files the
 * runner owns. While a runner is alive it is the only writer of task.json;
 * the server writes it only to create a task or before launching a runner.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "./config.js";
import { tasksDir } from "./paths.js";

export const TASK_ID_RE = /^t[0-9a-z]{10}$/;
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TaskStatus =
  | "starting"
  | "running"
  | "idle"
  | "stalled"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "rate_limited"
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

export interface TaskState {
  version: 1;
  id: string;
  name?: string;
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  spec: TaskSpec;
  session_id: string;
  /** True once `claude` has created the session; later starts use --resume. */
  session_started: boolean;
  /** Messages for the next runner start, sent as the first turn. */
  pending_messages: string[];
  runner: { pid: number; started_at: string } | null;
  claude_pid: number | null;
  turns: number;
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
}

/** Create the task folder and its first task.json. The prompt becomes the first turn. */
export function createTask(input: NewTask, env: NodeJS.ProcessEnv = process.env): TaskState {
  mkdirSync(tasksDir(env), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    const id = newTaskId();
    try {
      mkdirSync(taskDir(id, env), { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST" && attempt < 5) continue;
      throw err;
    }
    const now = new Date().toISOString();
    const state: TaskState = {
      version: 1,
      id,
      ...(input.name ? { name: input.name } : {}),
      created_at: now,
      updated_at: now,
      status: "starting",
      spec: input.spec,
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
