/**
 * Server-side helpers for runners: build a task spec from config, start a
 * detached runner, and talk to it over its socket. The MCP task tools
 * (build step 3) are built on these.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { resolveProfile, type Config } from "./config.js";
import type { RunnerRequest, TaskSummary, Delivery } from "./runner.js";
import { pidAlive } from "./session-lock.js";
import { readTask, taskFiles, writeTask, type TaskSpec } from "./task-store.js";

/** macOS limits a unix socket path to 104 bytes including the NUL (Linux: 108). */
export const MAX_SOCKET_PATH_BYTES = 103;
export const DEFAULT_INTERRUPT_TIMEOUT_MS = 15_000;
const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));
const MINUTE = 60_000;

export class RunnerError extends Error {
  readonly code = "ERUNNER" as const;
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}

export interface SpecInput {
  workdir: string;
  profile?: string;
  model?: string;
  effort?: string;
  system_prompt?: string;
  output_schema?: Record<string, unknown>;
  /** Per-turn cap; may only lower the config's `max_minutes`. */
  max_minutes?: number;
}

export function buildSpec(config: Config, input: SpecInput): TaskSpec {
  const { name, profile } = resolveProfile(config, input.profile);
  const asked = input.max_minutes;
  const maxMinutes =
    typeof asked === "number" && Number.isFinite(asked) && asked >= 1
      ? Math.min(Math.floor(asked), config.max_minutes)
      : config.max_minutes;
  return {
    workdir: input.workdir,
    profile_name: name,
    profile,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.system_prompt ? { system_prompt: input.system_prompt } : {}),
    ...(input.output_schema ? { output_schema: input.output_schema } : {}),
    max_turn_ms: maxMinutes * MINUTE,
    stall_ms: config.stall_minutes * MINUTE,
    idle_ms: config.idle_minutes * MINUTE,
    max_event_bytes: config.max_events_mb * 1024 * 1024,
    interrupt_timeout_ms: DEFAULT_INTERRUPT_TIMEOUT_MS,
  };
}

function runnerLogTail(path: string): string {
  try {
    return readFileSync(path, "utf8").slice(-1000).trim();
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Start the runner for a task whose task.json says `starting`, and wait until
 * it answers on its socket (or has already finished). The runner is
 * detached (own session), so it outlives this process.
 */
export async function launchRunner(
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 15_000,
): Promise<void> {
  const files = taskFiles(taskId, env);
  const sockBytes = Buffer.byteLength(files.socket, "utf8");
  if (sockBytes > MAX_SOCKET_PATH_BYTES) {
    throw new RunnerError(
      `runner socket path is too long (${sockBytes} > ${MAX_SOCKET_PATH_BYTES} bytes): ` +
        `${files.socket}; set CLAUDECODE_MCP_STATE_DIR to a shorter path`,
    );
  }
  const log = openSync(files.runnerLog, "a", 0o600);
  try {
    const child = spawn(process.execPath, [CLI_PATH, "runner", taskId], {
      detached: true,
      stdio: ["ignore", "ignore", log],
      env,
    });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await requestRunner(taskId, { op: "status" }, env, 1_000);
      return;
    } catch {
      // not listening yet, or already gone
    }
    const state = readTask(taskId, env);
    if (state.runner === null && state.status !== "starting") return;
    if (Date.now() > deadline) {
      const tail = runnerLogTail(files.runnerLog);
      throw new RunnerError(
        `runner for ${taskId} did not start within ${timeoutMs} ms` + (tail ? `: ${tail}` : ""),
      );
    }
    await sleep(50);
  }
}

/**
 * Queue a message on a task whose runner has exited (idle, interrupted, ...)
 * and start a new runner, which resumes the session with it.
 */
export async function resumeTask(
  taskId: string,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const state = readTask(taskId, env);
  if (state.runner && pidAlive(state.runner.pid)) {
    throw new RunnerError(`task ${taskId} already has a runner`);
  }
  // A runner that died without cleanup (SIGKILL, reboot) leaves a stale entry.
  state.runner = null;
  state.claude_pid = null;
  state.pending_messages.push(text);
  state.status = "starting";
  state.error = null;
  writeTask(state, env);
  await launchRunner(taskId, env);
}

export type RunnerResponse =
  { ok: true; task: TaskSummary; delivery?: Delivery } | { ok: false; error: string };

/** Send one request to a task's runner and wait for its one-line answer. */
export function requestRunner(
  taskId: string,
  req: RunnerRequest,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 10_000,
): Promise<RunnerResponse> {
  const { socket } = taskFiles(taskId, env);
  return new Promise((resolve, reject) => {
    const sock = connect(socket);
    let buf = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new RunnerError(`runner for ${taskId} did not answer`))),
      timeoutMs,
    );
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      settle(() => {
        try {
          resolve(JSON.parse(buf.slice(0, i)) as RunnerResponse);
        } catch (err) {
          reject(err);
        }
      });
    });
    sock.on("error", (err) => settle(() => reject(err)));
    sock.on("close", () =>
      settle(() => reject(new RunnerError(`runner for ${taskId} closed the connection`))),
    );
  });
}
