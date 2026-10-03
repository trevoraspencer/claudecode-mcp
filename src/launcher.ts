/**
 * Server-side helpers for runners: build a task spec from config, start a
 * detached runner, and talk to it over its socket. The MCP task tools
 * (build step 3) are built on these.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { resolveProfile, type Config } from "./config.js";
import { killGroup, type RunnerRequest, type TaskSummary, type Delivery } from "./runner.js";
import { recordAlive } from "./session-lock.js";
import { readTask, taskFiles, writeTask, type TaskSpec } from "./task-store.js";

/** macOS limits a unix socket path to 104 bytes including the NUL (Linux: 108). */
export const MAX_SOCKET_PATH_BYTES = 103;
export const DEFAULT_INTERRUPT_TIMEOUT_MS = 15_000;
const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));
const MINUTE = 60_000;
const LAUNCH_LOCK_STALE_MS = 60_000;
const LAUNCH_WAIT_MS = 30_000;

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

/** True if the task's recorded runner is still that live process. */
export function hasLiveRunner(state: { runner: { pid: number; started_at: string } | null }) {
  return state.runner !== null && recordAlive(state.runner.pid, state.runner.started_at);
}

/** Throw before creating a task if runner sockets would not fit the OS limit. */
export function assertSocketPathFits(env: NodeJS.ProcessEnv = process.env): void {
  const sample = taskFiles("t0000000000", env).socket;
  const bytes = Buffer.byteLength(sample, "utf8");
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new RunnerError(
      `runner socket path is too long (${bytes} > ${MAX_SOCKET_PATH_BYTES} bytes); ` +
        "set CLAUDECODE_MCP_STATE_DIR to a shorter path",
    );
  }
}

function launchLockPath(taskId: string, env: NodeJS.ProcessEnv): string {
  return join(taskFiles(taskId, env).dir, "launch.lock");
}

/** A launch lock is live while its holder runs and it is not too old. */
function launchLockLive(path: string): boolean {
  let holder: { pid?: unknown; started_at?: unknown };
  try {
    if (Date.now() - statSync(path).mtimeMs > LAUNCH_LOCK_STALE_MS) return false;
    holder = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // Missing: not live. Unreadable or half-written: treat as live until stale.
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
  return (
    typeof holder.pid === "number" &&
    recordAlive(holder.pid, typeof holder.started_at === "string" ? holder.started_at : undefined)
  );
}

/**
 * Run `fn` while holding the task's launch lock (`launch.lock`, created
 * with O_EXCL), so only one caller at a time, in any server process, can
 * start a runner for a task.
 */
export async function withLaunchLock<T>(
  taskId: string,
  env: NodeJS.ProcessEnv,
  fn: () => Promise<T>,
): Promise<T> {
  const path = launchLockPath(taskId, env);
  const deadline = Date.now() + LAUNCH_WAIT_MS;
  const body = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  for (;;) {
    try {
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!launchLockLive(path)) {
        try {
          unlinkSync(path);
        } catch {
          // someone else removed it
        }
        continue;
      }
      if (Date.now() > deadline) throw new RunnerError(`task ${taskId} is busy launching`);
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if (readFileSync(path, "utf8") === body) unlinkSync(path);
    } catch {
      // already gone
    }
  }
}

/** Wait until no launch is in progress for the task. */
export async function waitForLaunch(taskId: string, env: NodeJS.ProcessEnv): Promise<void> {
  const path = launchLockPath(taskId, env);
  const deadline = Date.now() + LAUNCH_WAIT_MS;
  while (launchLockLive(path)) {
    if (Date.now() > deadline) throw new RunnerError(`task ${taskId} is busy launching`);
    await sleep(50);
  }
}

/**
 * Start the runner for a task whose task.json says `starting`, and wait until
 * it answers on its socket (or has already finished). The runner is
 * detached (own session), so it outlives this process. Call it while holding
 * the task's launch lock.
 *
 * If the runner does not come up in time, it is killed (with any `claude` it
 * started) and the task is marked failed.
 */
export async function launchRunner(
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 15_000,
): Promise<void> {
  assertSocketPathFits(env);
  const files = taskFiles(taskId, env);
  const log = openSync(files.runnerLog, "a", 0o600);
  let runnerPid: number | undefined;
  try {
    const child = spawn(process.execPath, [CLI_PATH, "runner", taskId], {
      detached: true,
      stdio: ["ignore", "ignore", log],
      env,
    });
    child.on("error", () => {});
    child.unref();
    runnerPid = child.pid;
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
      killGroup(runnerPid, "SIGKILL");
      const s = readTask(taskId, env);
      if (s.claude_pid) killGroup(s.claude_pid, "SIGKILL");
      const tail = runnerLogTail(files.runnerLog);
      const message =
        `runner for ${taskId} did not start within ${timeoutMs} ms` + (tail ? `: ${tail}` : "");
      s.status = "failed";
      s.error = message.slice(0, 1000);
      s.runner = null;
      s.claude_pid = null;
      writeTask(s, env);
      throw new RunnerError(message);
    }
    await sleep(50);
  }
}

/**
 * Queue a message on a task whose runner has exited (idle, interrupted, ...)
 * and start a new runner, which resumes the session with it. Returns
 * "runner_alive" without queuing if another caller started a runner first;
 * the caller should then deliver over the socket.
 */
export async function resumeTask(
  taskId: string,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<"resumed" | "runner_alive"> {
  return withLaunchLock(taskId, env, async () => {
    const state = readTask(taskId, env);
    if (hasLiveRunner(state)) {
      // Trust the PID only if its socket answers: PIDs get reused.
      try {
        await requestRunner(taskId, { op: "status" }, env, 2_000);
        return "runner_alive";
      } catch {
        // stale record; fall through and replace it
      }
    }
    if (state.status === "closed") throw new RunnerError(`task ${taskId} is closed`);
    // A runner that died without cleanup (SIGKILL, reboot) leaves a stale entry.
    state.runner = null;
    state.claude_pid = null;
    state.pending_messages.push(text);
    state.status = "starting";
    state.error = null;
    writeTask(state, env);
    await launchRunner(taskId, env);
    return "resumed";
  });
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
