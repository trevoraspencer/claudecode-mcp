/**
 * The runner: one detached process per task (`claudecode-mcp runner <id>`).
 *
 * It owns the `claude -p` stream-json child: it writes user messages to the
 * child's stdin, appends every stdout event to events.jsonl, keeps task.json
 * current, and answers requests on `runner.sock` (newline-delimited JSON).
 *
 * Lifecycle (DESIGN-v2 section 4):
 * - A turn runs until `claude` emits a `result` event. The child then stays
 *   alive, idle, for `idle_ms`; a message in that window starts the next turn
 *   in the same process. After the window the runner closes stdin, `claude`
 *   exits, and the runner exits. A later message starts a new runner, which
 *   resumes the session with `--resume`.
 * - Interrupt: a stream-json `control_request` interrupt ends the turn and
 *   keeps the process. If that fails, SIGINT ends the process and the runner
 *   restarts it with `--resume`.
 * - Stop (cancel, timeout, caps, failures): SIGINT, then SIGTERM, then
 *   SIGKILL to the child's process group.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, closeSync, fstatSync, openSync, unlinkSync, writeSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { buildClaudeArgs, effectivePermissionMode } from "./claude-args.js";
import { getClaudeBin } from "./claude-cli.js";
import { buildChildEnv } from "./child-env.js";
import { debugLog, errorLog, warnLog } from "./log.js";
import { sanitizeForClient } from "./redaction.js";
import { acquireSessionLock, recordAlive, SessionBusyError } from "./session-lock.js";
import {
  readTask,
  taskFiles,
  writeTask,
  type TaskState,
  type TaskStatus,
  type TurnResult,
} from "./task-store.js";

const STDERR_TAIL_CHARS = 16 * 1024;
const MAX_LINE_CHARS = 16 * 1024 * 1024;
const MAX_REQUEST_CHARS = 4 * 1024 * 1024;
export const KILL_GRACE_MS = 5_000;
export const TERM_GRACE_MS = 2_000;
const PERSIST_DEBOUNCE_MS = 250;
const CLOSE_GRACE_MS = 1_000;
const LOCK_WAIT_MS = 5_000;

export type RunnerRequest =
  { op: "status" } | { op: "message"; text: string; interrupt?: boolean } | { op: "cancel" };

/** How a message was handled. */
export type Delivery =
  | "started" // the task was idle; the message starts a turn
  | "delivered" // written into the running turn
  | "interrupting" // the running turn is being interrupted; the message follows
  | "queued"; // sent when the current turn or restart completes

export interface TaskSummary {
  id: string;
  status: TaskStatus;
  session_id: string;
  workdir: string;
  turns: number;
  turn_started_at: string | null;
  last_event_at: string | null;
  events_bytes: number;
  result: TurnResult | null;
  rate_limit: unknown;
  error: string | null;
}

export function summarize(state: TaskState): TaskSummary {
  return {
    id: state.id,
    status: state.status,
    session_id: state.session_id,
    workdir: state.spec.workdir,
    turns: state.turns,
    turn_started_at: state.turn_started_at,
    last_event_at: state.last_event_at,
    events_bytes: state.events_bytes,
    result: state.result,
    rate_limit: state.rate_limit,
    error: state.error,
  };
}

/** Signal a whole process group. Returns false if it no longer exists. */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function resultOf(e: Record<string, unknown>): TurnResult {
  return {
    subtype: String(e.subtype ?? "unknown"),
    is_error: e.is_error === true,
    ...(typeof e.result === "string" ? { text: e.result } : {}),
    ...(e.structured_output !== undefined ? { structured_output: e.structured_output } : {}),
    ...(typeof e.num_turns === "number" ? { num_turns: e.num_turns } : {}),
    ...(typeof e.duration_ms === "number" ? { duration_ms: e.duration_ms } : {}),
    ...(e.usage !== undefined ? { usage: e.usage } : {}),
    ...(typeof e.total_cost_usd === "number" ? { total_cost_usd: e.total_cost_usd } : {}),
    ...(Array.isArray(e.permission_denials) ? { permission_denials: e.permission_denials } : {}),
  };
}

type TimerName = "turn" | "stall" | "idle" | "interrupt" | "persist";

class Runner {
  private state!: TaskState;
  private files!: ReturnType<typeof taskFiles>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private eventsFd = -1;
  private releaseLock: (() => void) | null = null;
  private turnActive = false;
  /** Messages to send when the current turn or restart completes. */
  private queue: string[] = [];
  private interrupting = false;
  /** The child got SIGINT for an interrupt; restart it with --resume when it exits. */
  private sigintFallback = false;
  private idleExit = false;
  private stopping = false;
  private finished = false;
  private readonly timers: Partial<Record<TimerName, NodeJS.Timeout>> = {};
  private readonly stopTimers: NodeJS.Timeout[] = [];
  private stderrTail = "";
  private readonly cancelWaiters: Socket[] = [];
  private requestSeq = 0;
  private done: (code: number) => void = () => {};

  constructor(
    private readonly id: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async run(): Promise<number> {
    this.state = readTask(this.id, this.env);
    this.files = taskFiles(this.id, this.env);
    const st = this.state.status;
    if (st === "cancelled" || st === "closing" || st === "closed") {
      debugLog({ phase: "runner_start", task_id: this.id, skipped: this.state.status });
      return 0;
    }
    const other = this.state.runner;
    if (other && other.pid !== process.pid && recordAlive(other.pid, other.started_at)) {
      errorLog({ phase: "runner_start", task_id: this.id, error: "another runner is active" });
      return 1;
    }
    try {
      this.releaseLock = await this.acquireLockWithRetry();
    } catch (err) {
      if (err instanceof SessionBusyError) {
        errorLog({ phase: "runner_start", task_id: this.id, error: err.message });
        // Record the failure only if no live runner owns the task meanwhile.
        const fresh = readTask(this.id, this.env);
        if (!fresh.runner || !recordAlive(fresh.runner.pid, fresh.runner.started_at)) {
          fresh.status = "failed";
          fresh.error = err.message;
          this.state = fresh;
          this.persistNow();
        }
        return 1;
      }
      throw err;
    }
    const exited = new Promise<number>((resolve) => (this.done = resolve));
    try {
      this.state.runner = { pid: process.pid, started_at: new Date().toISOString() };
      this.state.status = "starting";
      this.state.error = null;
      this.persistNow();
      this.eventsFd = openSync(this.files.events, "a", 0o600);
      this.state.events_bytes = fstatSync(this.eventsFd).size;
      await this.listen();
      // A signal during startup already stopped and finished the runner.
      if (this.stopping) return exited;
      this.spawnClaude(this.state.session_started);
      // pending_messages stay in task.json until claude's init event shows it
      // accepted them, so a failed start does not lose the prompt.
      const pending = this.state.pending_messages;
      if (pending.length > 0) this.beginTurn(pending.join("\n\n"));
      else this.enterIdle();
    } catch (err) {
      this.stop("failed", `runner could not start: ${(err as Error).message}`);
    }
    return exited;
  }

  /**
   * A runner that just finished marks the task free (runner: null) a moment
   * before it releases the session lock. A new runner started in that gap
   * waits briefly instead of failing the task.
   */
  private async acquireLockWithRetry(): Promise<() => void> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        return acquireSessionLock(this.state.session_id, this.id, this.env);
      } catch (err) {
        if (!(err instanceof SessionBusyError) || Date.now() >= deadline) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  // ── socket ────────────────────────────────────────────────────────

  private listen(): Promise<void> {
    try {
      unlinkSync(this.files.socket);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const server = createServer((sock) => this.onConnection(sock));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.files.socket, () => {
        server.off("error", reject);
        server.on("error", (err) => warnLog({ phase: "runner_socket", error: err.message }));
        chmodSync(this.files.socket, 0o600);
        resolve();
      });
    });
  }

  private onConnection(sock: Socket): void {
    this.sockets.add(sock);
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("close", () => this.sockets.delete(sock));
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_REQUEST_CHARS) {
        this.reply(sock, { ok: false, error: "request too large" });
        sock.destroy();
        return;
      }
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.handleRequest(sock, line);
      }
    });
  }

  private reply(sock: Socket, body: Record<string, unknown>): void {
    if (!sock.destroyed) sock.write(JSON.stringify(body) + "\n");
  }

  private handleRequest(sock: Socket, line: string): void {
    let req: Partial<RunnerRequest> & Record<string, unknown>;
    try {
      req = JSON.parse(line);
    } catch {
      this.reply(sock, { ok: false, error: "invalid JSON" });
      return;
    }
    switch (req?.op) {
      case "status":
        this.reply(sock, { ok: true, task: summarize(this.state) });
        return;
      case "message": {
        if (typeof req.text !== "string" || req.text.length === 0) {
          this.reply(sock, { ok: false, error: "text must be a non-empty string" });
          return;
        }
        if (this.stopping) {
          this.reply(sock, { ok: false, error: `task is stopping (${this.state.status})` });
          return;
        }
        const delivery = this.deliver(req.text, req.interrupt === true);
        this.reply(sock, { ok: true, delivery, task: summarize(this.state) });
        return;
      }
      case "cancel":
        this.cancelWaiters.push(sock);
        this.stop("cancelled", null);
        return;
      default:
        this.reply(sock, { ok: false, error: "unknown op" });
    }
  }

  // ── messages and turns ────────────────────────────────────────────

  private deliver(text: string, interrupt: boolean): Delivery {
    if (this.idleExit || this.sigintFallback) {
      this.queue.push(text);
      if (this.idleExit && this.state.status !== "starting") {
        // claude is exiting and will restart for this message; show it as busy.
        this.state.status = "starting";
        this.persistNow();
      }
      return "queued";
    }
    if (!this.turnActive) {
      this.beginTurn(text);
      return "started";
    }
    if (!interrupt) {
      if (this.interrupting) {
        this.queue.push(text);
        return "queued";
      }
      this.writeUser(text);
      return "delivered";
    }
    this.queue.push(text);
    if (!this.interrupting) this.interrupt();
    return "interrupting";
  }

  private send(event: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (stdin?.writable) stdin.write(JSON.stringify(event) + "\n");
  }

  private writeUser(text: string): void {
    this.send({ type: "user", message: { role: "user", content: text } });
  }

  private beginTurn(text: string): void {
    this.writeUser(text);
    this.markTurnStarted();
  }

  private markTurnStarted(): void {
    this.turnActive = true;
    this.state.status = "running";
    this.state.turn_started_at = new Date().toISOString();
    this.clearTimer("idle");
    this.setTimer("turn", this.state.spec.max_turn_ms, () =>
      this.stop(
        "timed_out",
        `turn exceeded its time cap (${Math.round(this.state.spec.max_turn_ms / 60_000)} min)`,
      ),
    );
    this.armStall();
    this.persistNow();
  }

  private armStall(): void {
    this.setTimer("stall", this.state.spec.stall_ms, () => {
      if (!this.turnActive || this.state.status !== "running") return;
      this.state.status = "stalled";
      warnLog({ phase: "runner_stall", task_id: this.id, stall_ms: this.state.spec.stall_ms });
      this.persistNow();
    });
  }

  private interrupt(): void {
    this.interrupting = true;
    this.send({
      type: "control_request",
      request_id: `runner-${++this.requestSeq}`,
      request: { subtype: "interrupt" },
    });
    this.setTimer("interrupt", this.state.spec.interrupt_timeout_ms, () => {
      if (!this.turnActive || this.stopping || !this.child) return;
      warnLog({ phase: "runner_interrupt", task_id: this.id, fallback: "SIGINT" });
      this.sigintFallback = true;
      this.child.kill("SIGINT");
      this.setTimer("interrupt", KILL_GRACE_MS, () => {
        if (this.sigintFallback) this.stop("failed", "claude did not stop after an interrupt");
      });
    });
  }

  private enterIdle(): void {
    this.turnActive = false;
    this.clearTimer("turn");
    this.clearTimer("stall");
    const limit = this.state.rate_limit as { status?: unknown } | null;
    this.state.status =
      this.state.result?.is_error && limit?.status === "rejected" ? "rate_limited" : "idle";
    this.setTimer("idle", this.state.spec.idle_ms, () => this.beginIdleExit());
    this.persistNow();
  }

  private beginIdleExit(): void {
    if (this.turnActive || this.stopping) return;
    if (!this.child) {
      this.finish();
      return;
    }
    this.idleExit = true;
    debugLog({ phase: "runner_idle_exit", task_id: this.id });
    const pid = this.child.pid;
    this.child.stdin.end();
    // claude should exit at once with no turn running; make sure it does.
    this.setTimer("idle", KILL_GRACE_MS, () => {
      killGroup(pid, "SIGTERM");
      this.setTimer("idle", TERM_GRACE_MS, () => killGroup(pid, "SIGKILL"));
    });
  }

  // ── the claude child ──────────────────────────────────────────────

  private spawnClaude(resume: boolean): void {
    const spec = this.state.spec;
    const args = buildClaudeArgs(spec, { id: this.state.session_id, resume });
    const child = spawn(getClaudeBin(this.env), args, {
      cwd: spec.workdir,
      env: buildChildEnv({
        parentEnv: this.env,
        profileEnv: {
          ...spec.profile.env,
          // A separate Claude home for the child (own settings, skills, login).
          ...(spec.profile.config_dir ? { CLAUDE_CONFIG_DIR: spec.profile.config_dir } : {}),
        },
      }),
      stdio: "pipe",
      // Own process group, so stop can signal claude and its tools together.
      detached: true,
    });
    this.child = child;
    this.stderrTail = "";
    let spawnError: Error | null = null;
    child.on("error", (err) => (spawnError = err));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    let out = "";
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      let i: number;
      while ((i = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        if (line.trim()) this.onLine(line);
      }
      if (out.length > MAX_LINE_CHARS) {
        out = "";
        this.stop("failed", "claude wrote an oversized output line");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    // Handle the exit once. `close` waits for every stdio pipe to close, and a
    // descendant that inherited stdout/stderr can hold them open forever; so
    // on `exit`, kill the group (which frees such pipes) and give `close` a
    // short grace before handling the exit anyway.
    let handled = false;
    const handle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (handled) return;
      handled = true;
      this.onClaudeExit(child, code, signal, spawnError);
    };
    child.on("exit", (code, signal) => {
      killGroup(child.pid, "SIGKILL");
      const grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        handle(code, signal);
      }, CLOSE_GRACE_MS);
      child.once("close", () => {
        clearTimeout(grace);
        handle(code, signal);
      });
    });
    child.on("close", (code, signal) => handle(code, signal));
    this.state.claude_pid = child.pid ?? null;
    debugLog({ phase: "runner_spawn", task_id: this.id, resume, pid: child.pid });
    this.persistNow();
  }

  private onLine(line: string): void {
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (this.state.events_bytes + bytes > this.state.spec.max_event_bytes) {
      this.stop(
        "failed",
        `event log reached its size cap (${this.state.spec.max_event_bytes} bytes)`,
      );
      return;
    }
    writeSync(this.eventsFd, line + "\n");
    this.state.events_bytes += bytes;
    this.state.last_event_at = new Date().toISOString();
    if (this.turnActive && !this.stopping) {
      if (this.state.status === "stalled") this.state.status = "running";
      this.armStall();
    }
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      this.persistSoon();
      return;
    }
    if (!e || typeof e !== "object") return;
    if (e.type === "system" && e.subtype === "init") this.onInit(e);
    else if (e.type === "rate_limit_event") this.state.rate_limit = e.rate_limit_info ?? null;
    else if (e.type === "result") {
      this.onResult(e);
      return;
    }
    this.persistSoon();
  }

  private onInit(e: Record<string, unknown>): void {
    // A message that arrived as a turn ended starts a turn on its own.
    if (!this.turnActive && !this.stopping) this.markTurnStarted();
    this.state.session_started = true;
    this.state.pending_messages = [];
    const want = effectivePermissionMode(this.state.spec);
    if (e.permissionMode !== want) {
      this.stop(
        "failed",
        `claude started in permission mode "${String(e.permissionMode)}", not "${want}". ` +
          "auto mode needs a model that supports it (sonnet or opus); pick another model or profile",
      );
    }
  }

  private onResult(e: Record<string, unknown>): void {
    this.clearTimer("turn");
    this.clearTimer("stall");
    // During the SIGINT fallback the timer is the watchdog for claude's exit.
    if (!this.sigintFallback) this.clearTimer("interrupt");
    this.interrupting = false;
    this.turnActive = false;
    this.state.turns++;
    this.state.turn_started_at = null;
    this.state.result = resultOf(e);
    if (this.stopping || this.sigintFallback) {
      this.persistNow();
      return;
    }
    if (this.queue.length > 0) {
      this.beginTurn(this.queue.splice(0).join("\n\n"));
      return;
    }
    this.enterIdle();
  }

  private onClaudeExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnError: Error | null,
  ): void {
    if (child !== this.child) return;
    this.child = null;
    this.state.claude_pid = null;
    // Tools that outlived claude belong to this task; do not leak them.
    killGroup(child.pid, "SIGKILL");
    if (this.stopping) {
      this.finish();
      return;
    }
    const restartWith = (resume: boolean) => {
      const text = this.queue.splice(0).join("\n\n");
      try {
        this.spawnClaude(resume);
      } catch (err) {
        this.stop("failed", `cannot restart claude: ${(err as Error).message}`);
        return;
      }
      if (text) this.beginTurn(text);
      else this.enterIdle();
    };
    if (this.sigintFallback) {
      // The old process may have exited without a result; reset the turn.
      this.sigintFallback = false;
      this.interrupting = false;
      this.turnActive = false;
      this.clearTimer("interrupt");
      this.clearTimer("turn");
      this.clearTimer("stall");
      restartWith(this.state.session_started);
      return;
    }
    if (this.idleExit) {
      if (this.queue.length > 0) {
        this.idleExit = false;
        restartWith(this.state.session_started);
        return;
      }
      this.finish();
      return;
    }
    if (!this.turnActive && code === 0 && !spawnError) {
      this.finish();
      return;
    }
    const detail = spawnError
      ? `cannot start claude: ${spawnError.message}`
      : `claude exited unexpectedly (code ${code}, signal ${signal})`;
    const tail = this.stderrTail.trim();
    this.stop("failed", tail ? `${detail}: ${tail}` : detail);
  }

  // ── stop and finish ───────────────────────────────────────────────

  stop(status: TaskStatus, error: string | null): void {
    if (this.stopping) return;
    this.stopping = true;
    for (const name of ["turn", "stall", "idle", "interrupt"] as const) this.clearTimer(name);
    this.state.status = status;
    this.state.error = error
      ? sanitizeForClient(error, 0, Object.values(this.state.spec.profile.env))
      : null;
    // Callers were told these were queued; keep them for the next start
    // unless the task was cancelled on purpose.
    if (status !== "cancelled") this.state.pending_messages.push(...this.queue.splice(0));
    this.persistNow();
    const child = this.child;
    if (!child) {
      this.finish();
      return;
    }
    // SIGINT first: claude ends the turn cleanly and saves the session.
    child.kill("SIGINT");
    this.stopTimers.push(
      setTimeout(() => killGroup(child.pid, "SIGTERM"), KILL_GRACE_MS),
      setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS + TERM_GRACE_MS),
    );
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const name of Object.keys(this.timers) as TimerName[]) this.clearTimer(name);
    for (const t of this.stopTimers) clearTimeout(t);
    this.state.runner = null;
    this.state.claude_pid = null;
    this.persistNow();
    const summary = summarize(this.state);
    for (const sock of this.cancelWaiters) {
      this.reply(sock, { ok: true, task: summary });
      sock.end();
    }
    this.server?.close();
    for (const sock of this.sockets) if (!this.cancelWaiters.includes(sock)) sock.destroy();
    try {
      unlinkSync(this.files.socket);
    } catch {
      // already gone
    }
    if (this.eventsFd >= 0) closeSync(this.eventsFd);
    this.releaseLock?.();
    this.done(this.state.status === "failed" ? 1 : 0);
  }

  /** Last resort after an unexpected exception: kill the child and record the failure. */
  emergency(err: unknown): void {
    errorLog({ phase: "runner_crash", task_id: this.id, error: String(err).slice(0, 500) });
    killGroup(this.child?.pid, "SIGKILL");
    try {
      if (this.state) {
        this.state.status = "failed";
        this.state.error = sanitizeForClient(`runner crashed: ${String(err)}`);
        this.state.runner = null;
        this.state.claude_pid = null;
        this.persistNow();
      }
    } finally {
      this.releaseLock?.();
    }
  }

  // ── timers and persistence ────────────────────────────────────────

  private setTimer(name: TimerName, ms: number, fn: () => void): void {
    this.clearTimer(name);
    this.timers[name] = setTimeout(() => {
      delete this.timers[name];
      fn();
    }, ms);
  }

  private clearTimer(name: TimerName): void {
    const t = this.timers[name];
    if (t) clearTimeout(t);
    delete this.timers[name];
  }

  private persistSoon(): void {
    if (this.timers.persist) return;
    this.setTimer("persist", PERSIST_DEBOUNCE_MS, () => this.persistNow());
  }

  private persistNow(): void {
    this.clearTimer("persist");
    try {
      writeTask(this.state, this.env);
    } catch (err) {
      errorLog({ phase: "runner_persist", task_id: this.id, error: (err as Error).message });
    }
  }
}

/** Entry for `claudecode-mcp runner <task-id>`. Resolves to the exit code. */
export async function runRunner(
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const runner = new Runner(taskId, env);
  const onSignal = (signal: NodeJS.Signals) =>
    runner.stop("interrupted", `runner received ${signal}`);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, onSignal);
  process.on("uncaughtException", (err) => {
    runner.emergency(err);
    process.exit(1);
  });
  return runner.run();
}
