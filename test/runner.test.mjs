// Runner tests: real detached runner processes driving the fake claude.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseConfig } from "../dist/config.js";
import {
  buildSpec,
  launchRunner,
  requestRunner,
  resumeTask,
  RunnerError,
} from "../dist/launcher.js";
import { ensureStateDir } from "../dist/paths.js";
import { pidAlive, sessionLockPath } from "../dist/session-lock.js";
import { createTask, readTask, taskFiles, writeTask } from "../dist/task-store.js";

const STUB = join(dirname(fileURLToPath(import.meta.url)), "_fake_claude.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Create a task with a short state path (unix socket limit) and start its runner. */
async function start(
  t,
  prompt,
  { spec: specOverrides = {}, env: envExtra = {}, config = {} } = {},
) {
  const dir = mkdtempSync("/tmp/ccm-");
  const workdir = join(dir, "w");
  mkdirSync(workdir);
  const env = {
    ...process.env,
    CLAUDECODE_MCP_STATE_DIR: join(dir, "s"),
    CLAUDECODE_MCP_CLAUDE_BIN: STUB,
    CLAUDECODE_MCP_FAKE_ARGV_OUT: join(dir, "argv.jsonl"),
    CLAUDECODE_MCP_DEPTH: "",
    ...envExtra,
  };
  ensureStateDir(env);
  const spec = { ...buildSpec(parseConfig(config), { workdir }), ...specOverrides };
  const { id } = createTask({ spec, prompt }, env);
  t.after(async () => {
    const s = readTask(id, env);
    if (s.runner && pidAlive(s.runner.pid)) {
      await requestRunner(id, { op: "cancel" }, env, 15_000).catch(() => {});
    }
  });
  await launchRunner(id, env);
  const task = () => readTask(id, env);
  const argv = () =>
    readFileSync(env.CLAUDECODE_MCP_FAKE_ARGV_OUT, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  const events = () =>
    readFileSync(taskFiles(id, env).events, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  return { id, env, dir, workdir, task, argv, events };
}

const status = (ctx, s) => waitFor(() => ctx.task().status === s && ctx.task(), `status ${s}`);
const runnerGone = (ctx) => waitFor(() => ctx.task().runner === null && ctx.task(), "runner exit");

test("a first turn runs and the task goes idle with the result", async (t) => {
  const ctx = await start(t, "hello");
  const s = await status(ctx, "idle");
  assert.equal(s.turns, 1);
  assert.equal(s.result.text, "echo: hello");
  assert.equal(s.result.is_error, false);
  assert.equal(s.session_started, true);
  assert.ok(s.runner.pid > 0);
  assert.deepEqual(
    ctx.events().map((e) => e.type),
    ["system", "assistant", "result"],
  );
  const [args] = ctx.argv();
  for (const a of ["-p", "--verbose", "--strict-mcp-config"]) assert.ok(args.includes(a), a);
  assert.equal(args[args.indexOf("--session-id") + 1], s.session_id);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "auto");
  assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
  assert.equal(args.includes("hello"), false, "the prompt must not be in argv");
  assert.ok(existsSync(sessionLockPath(s.session_id, ctx.env)));
});

test("status over the socket, then a second turn in the same process", async (t) => {
  const ctx = await start(t, "one");
  await status(ctx, "idle");
  const st = await requestRunner(ctx.id, { op: "status" }, ctx.env);
  assert.equal(st.ok, true);
  assert.equal(st.task.status, "idle");
  const r = await requestRunner(ctx.id, { op: "message", text: "two" }, ctx.env);
  assert.equal(r.delivery, "started");
  await waitFor(() => ctx.task().turns === 2 && ctx.task().status === "idle", "turn 2");
  assert.equal(ctx.task().result.text, "echo: two");
  assert.equal(ctx.argv().length, 1, "no restart for an idle message");
});

test("a message during a turn joins that turn", async (t) => {
  const ctx = await start(t, "SLOW 800");
  await status(ctx, "running");
  const r = await requestRunner(ctx.id, { op: "message", text: "more" }, ctx.env);
  assert.equal(r.delivery, "delivered");
  const s = await status(ctx, "idle");
  assert.equal(s.result.text, "echo: SLOW 800 | also: more");
  assert.equal(s.turns, 1);
});

test("interrupt ends the turn and runs the new message in the same process", async (t) => {
  const ctx = await start(t, "SLOW 30000");
  await status(ctx, "running");
  const r = await requestRunner(
    ctx.id,
    { op: "message", text: "instead", interrupt: true },
    ctx.env,
  );
  assert.equal(r.delivery, "interrupting");
  await waitFor(() => ctx.task().turns === 2 && ctx.task().status === "idle", "turn 2");
  assert.equal(ctx.task().result.text, "echo: instead");
  const subtypes = ctx
    .events()
    .filter((e) => e.type === "result")
    .map((e) => e.subtype);
  assert.deepEqual(subtypes, ["error_during_execution", "success"]);
  assert.equal(ctx.argv().length, 1);
});

test("if the interrupt is ignored, SIGINT and --resume take over", async (t) => {
  const ctx = await start(t, "IGNORE_INTERRUPT", { spec: { interrupt_timeout_ms: 200 } });
  await status(ctx, "running");
  await requestRunner(ctx.id, { op: "message", text: "after", interrupt: true }, ctx.env);
  await waitFor(() => ctx.task().result?.text === "echo: after", "resumed turn");
  const runs = ctx.argv();
  assert.equal(runs.length, 2);
  assert.equal(runs[1][runs[1].indexOf("--resume") + 1], ctx.task().session_id);
});

test("after the idle window the runner exits; a new message resumes the session", async (t) => {
  const ctx = await start(t, "first", { spec: { idle_ms: 200 } });
  const s = await runnerGone(ctx);
  assert.equal(s.status, "idle");
  assert.equal(s.claude_pid, null);
  assert.equal(existsSync(taskFiles(ctx.id, ctx.env).socket), false);
  assert.equal(existsSync(sessionLockPath(s.session_id, ctx.env)), false);

  await resumeTask(ctx.id, "second", ctx.env);
  await waitFor(() => ctx.task().result?.text === "echo: second", "resumed turn");
  const runs = ctx.argv();
  assert.equal(runs.length, 2);
  assert.ok(runs[1].includes("--resume"));
  assert.equal(runs[1].includes("--session-id"), false);
  assert.equal(ctx.task().turns, 2);
});

test("a permission mode other than the requested one fails the task", async (t) => {
  const ctx = await start(t, "hi", { env: { CLAUDECODE_MCP_FAKE_PERMISSION_MODE: "default" } });
  const s = await runnerGone(ctx);
  assert.equal(s.status, "failed");
  assert.match(s.error, /permission mode "default", not "auto"/);
});

test("a turn over its time cap is stopped as timed_out", async (t) => {
  const ctx = await start(t, "HANG", { spec: { max_turn_ms: 300 } });
  const s = await runnerGone(ctx);
  assert.equal(s.status, "timed_out");
  assert.match(s.error, /time cap/);
});

test("a quiet turn is flagged stalled, and cancel stops it", async (t) => {
  const ctx = await start(t, "HANG", { spec: { stall_ms: 200 } });
  await status(ctx, "stalled");
  const r = await requestRunner(ctx.id, { op: "cancel" }, ctx.env, 15_000);
  assert.equal(r.ok, true);
  assert.equal(r.task.status, "cancelled");
  const s = await runnerGone(ctx);
  assert.equal(s.status, "cancelled");
  assert.equal(pidAlive(s.runner?.pid ?? 0), false);
});

test("cancel kills the whole process group, tools included", async (t) => {
  const ctx = await start(t, "placeholder");
  await status(ctx, "idle");
  const pidFile = join(ctx.dir, "kid.pid");
  await requestRunner(ctx.id, { op: "message", text: `SPAWN_CHILD ${pidFile}` }, ctx.env);
  const kid = Number(
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8"), "kid"),
  );
  assert.equal(pidAlive(kid), true);
  await requestRunner(ctx.id, { op: "cancel" }, ctx.env, 15_000);
  await waitFor(() => !pidAlive(kid), "tool process killed");
});

test("hitting the event log cap fails the task without exceeding the cap", async (t) => {
  const ctx = await start(t, "BIG 5000", { spec: { max_event_bytes: 2000 } });
  const s = await runnerGone(ctx);
  assert.equal(s.status, "failed");
  assert.match(s.error, /size cap/);
  assert.ok(readFileSync(taskFiles(ctx.id, ctx.env).events).length <= 2000);
});

test("a crashing claude fails the task with a redacted error", async (t) => {
  const ctx = await start(t, "CRASH");
  const s = await runnerGone(ctx);
  assert.equal(s.status, "failed");
  assert.match(s.error, /exited unexpectedly \(code 3/);
  assert.doesNotMatch(s.error, /FAKESECRET/);
});

test("rate limit info is recorded", async (t) => {
  const ctx = await start(t, "RATE");
  const s = await status(ctx, "idle");
  assert.equal(s.rate_limit.utilization, 0.42);
});

test("the claude child gets the filtered env with the depth marker", async (t) => {
  const envOut = join(mkdtempSync("/tmp/ccm-"), "env.json");
  const ctx = await start(t, "hi", {
    env: { CLAUDECODE: "1", CLAUDECODE_MCP_FAKE_ENV_OUT: envOut, SOME_SECRET: "x" },
    config: { profiles: { worker: { env: { PROFILE_VAR: "p" } } } },
  });
  await status(ctx, "idle");
  const seen = JSON.parse(readFileSync(envOut, "utf8"));
  assert.equal(seen.CLAUDECODE, undefined);
  assert.equal(seen.SOME_SECRET, undefined);
  assert.equal(seen.CLAUDECODE_MCP_DEPTH, "1");
  assert.equal(seen.PROFILE_VAR, "p");
});

test("a second runner for the same task refuses to start", async (t) => {
  const ctx = await start(t, "hi");
  await status(ctx, "idle");
  const before = ctx.task();
  const { spawnSync } = await import("node:child_process");
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "runner", ctx.id], {
    env: ctx.env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /another runner is active/);
  assert.equal(ctx.task().runner.pid, before.runner.pid);
});

test("bad socket requests get errors, not crashes", async (t) => {
  const ctx = await start(t, "hi");
  await status(ctx, "idle");
  assert.equal((await requestRunner(ctx.id, { op: "nope" }, ctx.env)).ok, false);
  assert.equal((await requestRunner(ctx.id, { op: "message", text: "" }, ctx.env)).ok, false);
  assert.equal((await requestRunner(ctx.id, { op: "status" }, ctx.env)).ok, true);
});

test("launch refuses a socket path that is too long", async () => {
  const long = join(mkdtempSync("/tmp/ccm-"), "x".repeat(90));
  const env = { ...process.env, CLAUDECODE_MCP_STATE_DIR: long };
  ensureStateDir(env);
  const spec = buildSpec(parseConfig({}), { workdir: "/tmp" });
  const { id } = createTask({ spec, prompt: "hi" }, env);
  await assert.rejects(launchRunner(id, env), RunnerError);
});

// ── regressions from review ───────────────────────────────────────────

test("idle exit completes even when a descendant holds claude's stdout", async (t) => {
  const ctx = await start(t, "placeholder", { spec: { idle_ms: 300 } });
  const pidFile = join(ctx.dir, "kid.pid");
  await requestRunner(ctx.id, { op: "message", text: `INHERIT ${pidFile}` }, ctx.env);
  const s = await runnerGone(ctx);
  assert.equal(s.status, "idle");
  const kid = Number(readFileSync(pidFile, "utf8"));
  await waitFor(() => !pidAlive(kid), "inheriting descendant killed");
});

test("after a SIGINT fallback with no result, the next turn works normally", async (t) => {
  const ctx = await start(t, "IGNORE_INTERRUPT SILENT", { spec: { interrupt_timeout_ms: 200 } });
  await status(ctx, "running");
  await requestRunner(ctx.id, { op: "message", text: "next", interrupt: true }, ctx.env);
  await waitFor(() => ctx.task().result?.text === "echo: next", "restarted turn");
  const r = await requestRunner(ctx.id, { op: "message", text: "plain" }, ctx.env);
  assert.equal(r.delivery, "started");
  await waitFor(() => ctx.task().result?.text === "echo: plain", "plain turn");
  const runs = ctx.argv();
  assert.equal(runs.length, 2);
  assert.ok(runs[1].includes("--resume"), "the session had started, so resume it");
});

test("resume works after a runner died without cleanup", async (t) => {
  const ctx = await start(t, "first", { spec: { idle_ms: 200 } });
  await runnerGone(ctx);
  const s = ctx.task();
  s.runner = { pid: 2 ** 30, started_at: new Date().toISOString() };
  writeTask(s, ctx.env);
  await resumeTask(ctx.id, "second", ctx.env);
  await waitFor(() => ctx.task().result?.text === "echo: second", "resumed turn");
});

test("a busy session lock fails the task instead of leaving it starting", async () => {
  const dir = mkdtempSync("/tmp/ccm-");
  const env = {
    ...process.env,
    CLAUDECODE_MCP_STATE_DIR: join(dir, "s"),
    CLAUDECODE_MCP_CLAUDE_BIN: STUB,
  };
  ensureStateDir(env);
  const spec = buildSpec(parseConfig({}), { workdir: dir });
  const st = createTask({ spec, prompt: "hi" }, env);
  const lock = sessionLockPath(st.session_id, env);
  mkdirSync(dirname(lock), { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  await launchRunner(st.id, env);
  const s = readTask(st.id, env);
  assert.equal(s.status, "failed");
  assert.match(s.error, /already in use/);
});

test("a prompt claude never accepted is kept for the next start", async (t) => {
  const ctx = await start(t, "keep me", {
    env: { CLAUDECODE_MCP_CLAUDE_BIN: "/nonexistent/claude" },
  });
  const s = await runnerGone(ctx);
  assert.equal(s.status, "failed");
  assert.match(s.error, /cannot start claude/);
  assert.deepEqual(s.pending_messages, ["keep me"]);
});
