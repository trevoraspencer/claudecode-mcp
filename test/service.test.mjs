// TaskService in-process: races and edge cases from review.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseConfig } from "../dist/config.js";
import { buildSpec, launchRunner, requestRunner, withLaunchLock } from "../dist/launcher.js";
import { ensureStateDir } from "../dist/paths.js";
import { TaskService } from "../dist/service.js";
import { pidAlive } from "../dist/session-lock.js";
import { createTask, readTask, writeTask } from "../dist/task-store.js";
import { initRepo } from "./_mcp.mjs";

const STUB = join(dirname(fileURLToPath(import.meta.url)), "_fake_claude.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(t, envExtra = {}) {
  const dir = mkdtempSync("/tmp/ccm-");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  initRepo(repo);
  const env = {
    ...process.env,
    CLAUDECODE_MCP_STATE_DIR: join(dir, "s"),
    CLAUDECODE_MCP_CLAUDE_BIN: STUB,
    CLAUDECODE_MCP_FAKE_ARGV_OUT: join(dir, "argv.jsonl"),
    CLAUDECODE_MCP_DEPTH: "",
    ...envExtra,
  };
  ensureStateDir(env);
  const config = parseConfig({ allowed_roots: [dir] });
  const svc = new TaskService(config, env);
  const ids = [];
  t.after(async () => {
    for (const id of ids) {
      const s = readTask(id, env);
      if (s.runner && pidAlive(s.runner.pid)) {
        await requestRunner(id, { op: "cancel" }, env, 15_000).catch(() => {});
      }
    }
  });
  return { dir, repo, env, config, svc, ids };
}

async function settle(svc, id, check = () => true) {
  for (let i = 0; i < 40; i++) {
    const v = await svc.waitTask(id, 5);
    if (!v.wait_timed_out && check(v)) return v;
  }
  throw new Error("never settled");
}

test("cancel during a launch waits and cancels over the socket", async (t) => {
  const ctx = setup(t);
  const spec = buildSpec(ctx.config, { workdir: ctx.repo });
  const { id } = createTask({ spec, prompt: "SLOW 30000" }, ctx.env);
  ctx.ids.push(id);
  const launching = withLaunchLock(id, ctx.env, async () => {
    await sleep(300);
    await launchRunner(id, ctx.env);
  });
  await sleep(50);
  const view = await ctx.svc.cancelTask(id);
  await launching;
  assert.equal(view.status, "cancelled");
  assert.equal(view.runner_alive, false);
  await sleep(500);
  assert.equal(readTask(id, ctx.env).status, "cancelled", "the runner did not run on after cancel");
});

test("two concurrent messages to an exited task start one runner and never fail", async (t) => {
  const ctx = setup(t);
  const v = await ctx.svc.startTask({ prompt: "one", repo: ctx.repo });
  ctx.ids.push(v.task_id);
  await settle(ctx.svc, v.task_id);
  await ctx.svc.cancelTask(v.task_id);
  const seen = new Set();
  let polling = true;
  const poll = (async () => {
    while (polling) {
      seen.add(readTask(v.task_id, ctx.env).status);
      await sleep(5);
    }
  })();
  const [a, b] = await Promise.all([
    ctx.svc.sendMessage(v.task_id, "SLOW 300", false),
    ctx.svc.sendMessage(v.task_id, "second", false),
  ]);
  assert.deepEqual(
    [a.delivery, b.delivery].filter((d) => d === "resumed").length,
    1,
    `deliveries: ${a.delivery}, ${b.delivery}`,
  );
  await settle(ctx.svc, v.task_id, (x) => x.status === "idle");
  polling = false;
  await poll;
  assert.equal(seen.has("failed"), false, `statuses seen: ${[...seen]}`);
});

test("a recorded runner whose socket is gone does not block a resume", async (t) => {
  const ctx = setup(t);
  const v = await ctx.svc.startTask({ prompt: "one", repo: ctx.repo });
  ctx.ids.push(v.task_id);
  await settle(ctx.svc, v.task_id);
  await ctx.svc.cancelTask(v.task_id);
  // Simulate PID reuse: a live, unrelated PID recorded as the runner.
  const s = readTask(v.task_id, ctx.env);
  s.status = "idle";
  s.runner = { pid: process.pid, started_at: new Date().toISOString() };
  writeTask(s, ctx.env);
  const r = await ctx.svc.sendMessage(v.task_id, "again", false);
  assert.equal(r.delivery, "resumed");
  await settle(ctx.svc, v.task_id, (x) => x.result?.text === "echo: again");
});

test("cancel of a task with a stale runner record marks it cancelled", async (t) => {
  const ctx = setup(t);
  const spec = buildSpec(ctx.config, { workdir: ctx.repo });
  const st = createTask({ spec, prompt: "x" }, ctx.env);
  st.status = "idle";
  st.runner = { pid: process.pid, started_at: new Date().toISOString() };
  writeTask(st, ctx.env);
  const v = await ctx.svc.cancelTask(st.id);
  assert.equal(v.status, "cancelled");
  assert.equal(readTask(st.id, ctx.env).runner, null);
});

test("a runner recorded before the last boot counts as dead", async (t) => {
  const ctx = setup(t);
  const spec = buildSpec(ctx.config, { workdir: ctx.repo });
  const st = createTask({ spec, prompt: "x" }, ctx.env);
  st.status = "running";
  st.runner = { pid: process.pid, started_at: "2000-01-01T00:00:00.000Z" };
  writeTask(st, ctx.env);
  const v = ctx.svc.view(st.id);
  assert.equal(v.status, "interrupted");
  assert.equal(v.runner_alive, false);
});

test("large result parts are capped in views", async (t) => {
  const ctx = setup(t);
  const spec = buildSpec(ctx.config, { workdir: ctx.repo });
  const st = createTask({ spec, prompt: "x" }, ctx.env);
  st.status = "idle";
  st.result = {
    subtype: "success",
    is_error: false,
    text: "y".repeat(30_000),
    structured_output: { big: "z".repeat(200_000) },
    permission_denials: Array.from({ length: 30 }, (_, i) => ({
      tool_name: "Bash",
      tool_input: { command: String(i).repeat(5_000) },
    })),
  };
  writeTask(st, ctx.env);
  const r = ctx.svc.view(st.id).result;
  assert.equal(r.text.length, 20_000);
  assert.equal(r.text_truncated, true);
  assert.equal(r.structured_output, undefined);
  assert.equal(r.structured_output_truncated, true);
  assert.equal(r.permission_denials.length, 20);
  assert.equal(r.permission_denials_total, 30);
  assert.ok(r.permission_denials[0].truncated);
  assert.ok(JSON.stringify(r).length < 200_000);
});

test("start_task refuses a too-long state path before creating a task", async (t) => {
  const long = join(mkdtempSync("/tmp/ccm-"), "x".repeat(90));
  const ctx = setup(t, { CLAUDECODE_MCP_STATE_DIR: long });
  await assert.rejects(
    ctx.svc.startTask({ prompt: "x", repo: ctx.repo }),
    /socket path is too long/,
  );
  assert.deepEqual(ctx.svc.listTasks({}), []);
});

test("every task tool refuses at depth 1", async (t) => {
  const ctx = setup(t, { CLAUDECODE_MCP_DEPTH: "1" });
  const id = "t0000000000";
  const calls = [
    () => ctx.svc.view(id),
    () => ctx.svc.waitTask(id, 1),
    () => ctx.svc.getEvents(id, 0, 1),
    () => ctx.svc.cancelTask(id),
    () => ctx.svc.listTasks({}),
    () => ctx.svc.sendMessage(id, "x", false),
    () => ctx.svc.startTask({ prompt: "x", repo: ctx.repo }),
    () => ctx.svc.ask({ prompt: "x" }),
  ];
  for (const call of calls) {
    await assert.rejects(async () => call(), /recursive delegation/);
  }
});
