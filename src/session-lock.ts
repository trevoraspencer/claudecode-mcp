/**
 * One active `claude` process per session. The CLI does not lock sessions
 * (two processes can resume one session at once), so the runner takes an
 * exclusive lock file `sessions/<session-id>.lock` holding its PID.
 */

import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

export function sessionLockPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error("invalid session id");
  return join(stateDir(env), "sessions", `${sessionId}.lock`);
}

function readHolder(path: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : 0;
  } catch {
    return 0;
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
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, task_id: taskId }) + "\n", {
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
        if ((holder !== process.pid && pidAlive(holder)) || attempt >= 2) {
          throw new SessionBusyError(sessionId, holder);
        }
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
    if (readHolder(path) !== process.pid) return;
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  };
}
