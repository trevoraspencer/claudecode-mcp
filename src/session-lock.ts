/**
 * One active `claude` process per session. The CLI does not lock sessions
 * (two processes can resume one session at once), so the runner takes an
 * exclusive lock file `sessions/<session-id>.lock` holding its PID.
 */

import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { stateDir } from "./paths.js";
import { SESSION_ID_RE } from "./task-store.js";

export class SessionBusyError extends Error {
  readonly code = "ESESSIONBUSY" as const;
  constructor(
    sessionId: string,
    public readonly holderPid: number,
  ) {
    super(`session ${sessionId} is already in use by process ${holderPid}`);
    this.name = "SessionBusyError";
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Wall-clock time of the last boot, in ms. */
export function bootTimeMs(): number {
  return Date.now() - uptime() * 1000;
}

/**
 * Is the process recorded as (pid, startedAt) still that process? A PID from
 * before the last boot belongs to someone else now, even if it is alive.
 */
export function recordAlive(pid: number, startedAt?: string): boolean {
  if (!pidAlive(pid)) return false;
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  // One minute of slack for clock and uptime rounding.
  return !(Number.isFinite(started) && started < bootTimeMs() - 60_000);
}

export function sessionLockPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error("invalid session id");
  return join(stateDir(env), "sessions", `${sessionId}.lock`);
}

function readHolder(path: string): { pid: number; started_at?: string } {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      pid?: unknown;
      started_at?: unknown;
    };
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      ...(typeof parsed.started_at === "string" ? { started_at: parsed.started_at } : {}),
    };
  } catch {
    return { pid: 0 };
  }
}

/**
 * Take the lock or throw SessionBusyError. A lock whose holder is dead is
 * stale and is replaced. Returns a release function.
 *
 * Two processes clearing the same stale lock at the same moment could still
 * both succeed; the server launches at most one runner per task, which keeps
 * that window closed in practice.
 */
export function acquireSessionLock(
  sessionId: string,
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const path = sessionLockPath(sessionId, env);
  mkdirSync(join(stateDir(env), "sessions"), { recursive: true, mode: 0o700 });
  // Write the content to a temp file, then hard-link it into place: the lock
  // appears atomically with its PID, so no one can read it half-written.
  const tmp = `${path}.${process.pid}.tmp`;
  const started_at = new Date().toISOString();
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, started_at, task_id: taskId }) + "\n", {
    mode: 0o600,
  });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(tmp, path);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const holder = readHolder(path);
        const live = holder.pid !== process.pid && recordAlive(holder.pid, holder.started_at);
        if (live || attempt >= 2) throw new SessionBusyError(sessionId, holder.pid);
        try {
          unlinkSync(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
    }
  } finally {
    unlinkSync(tmp);
  }
  return () => {
    if (readHolder(path).pid !== process.pid) return;
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  };
}
