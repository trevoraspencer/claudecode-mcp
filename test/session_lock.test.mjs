import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  acquireSessionLock,
  pidAlive,
  SessionBusyError,
  sessionLockPath,
} from "../dist/session-lock.js";

const SID = "123e4567-e89b-42d3-a456-426614174000";
const envFor = () => ({ CLAUDECODE_MCP_STATE_DIR: mkdtempSync(join(tmpdir(), "ccm-lock-")) });

test("acquire and release", () => {
  const env = envFor();
  const release = acquireSessionLock(SID, "t0000000000", env);
  assert.ok(existsSync(sessionLockPath(SID, env)));
  release();
  assert.equal(existsSync(sessionLockPath(SID, env)), false);
});

test("a lock held by a live process is busy", () => {
  const env = envFor();
  const path = sessionLockPath(SID, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.ppid, task_id: "x" }));
  assert.throws(() => acquireSessionLock(SID, "t0000000000", env), SessionBusyError);
});

test("a stale lock (dead holder or garbage) is replaced", () => {
  const env = envFor();
  const path = sessionLockPath(SID, env);
  mkdirSync(dirname(path), { recursive: true });
  for (const content of [JSON.stringify({ pid: 2 ** 30 }), "garbage"]) {
    writeFileSync(path, content);
    const release = acquireSessionLock(SID, "t0000000000", env);
    release();
  }
});

test("release does not remove a lock someone else now holds", () => {
  const env = envFor();
  const release = acquireSessionLock(SID, "t0000000000", env);
  writeFileSync(sessionLockPath(SID, env), JSON.stringify({ pid: process.ppid }));
  release();
  assert.ok(existsSync(sessionLockPath(SID, env)));
});

test("no temp files are left behind", async () => {
  const env = envFor();
  const release = acquireSessionLock(SID, "t0000000000", env);
  release();
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(join(env.CLAUDECODE_MCP_STATE_DIR, "sessions")), []);
});

test("session ids are validated", () => {
  assert.throws(() => sessionLockPath("../../etc/passwd", envFor()));
});

test("pidAlive", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(2 ** 30), false);
});
