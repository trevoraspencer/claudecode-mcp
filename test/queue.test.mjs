// max_concurrent queue, dispatcher, restart recovery, and rate-limit holds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { sandbox, startServer } from "./_mcp.mjs";
import { readTask, writeTask } from "../dist/task-store.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function server(t, config = {}, envExtra = {}) {
  const box = sandbox(
    { max_concurrent: 1, ...config },
    { CLAUDECODE_MCP_DISPATCH_MS: "200", ...envExtra },
  );
  const srv = await startServer(box.env);
  t.after(async () => {
    for (const task of (await srv.call("list_tasks", {})).json ?? []) {
      if (["running", "idle", "stalled", "starting", "queued"].includes(task.status)) {
        await srv.call("cancel_task", { task_id: task.task_id }, { timeoutMs: 30_000 });
      }
    }
    srv.stop();
  });
  return { ...box, ...srv };
}

async function until(s, id, check, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const v = (await s.call("get_task", { task_id: id })).json;
    if (check(v)) return v;
    await sleep(100);
  }
  throw new Error(`task ${id} never reached the expected state`);
}

test("over max_concurrent, tasks queue in order and start as slots free", async (t) => {
  const s = await server(t);
  const a = (await s.call("start_task", { prompt: "HANG", repo: s.repo, isolation: "in_place" }))
    .json;
  assert.equal(a.status, "running");
  const b = (await s.call("start_task", { prompt: "second", repo: s.repo, isolation: "in_place" }))
    .json;
  const c = (await s.call("start_task", { prompt: "third", repo: s.repo, isolation: "in_place" }))
    .json;
  assert.equal(b.status, "queued");
  assert.deepEqual(b.queue, { position: 1, active: 1, max_concurrent: 1 });
  assert.equal(c.queue.position, 2);
  await sleep(600);
  assert.equal(
    (await s.call("get_task", { task_id: b.task_id })).json.status,
    "queued",
    "still waiting",
  );

  await s.call("cancel_task", { task_id: a.task_id });
  const bDone = await until(s, b.task_id, (v) => v.status === "idle");
  assert.equal(bDone.result.text, "echo: second");
  // b is idle (not in a turn), so c gets the slot next.
  const cDone = await until(s, c.task_id, (v) => v.status === "idle");
  assert.equal(cDone.result.text, "echo: third");
});

test("wait_task waits through the queue", async (t) => {
  const s = await server(t);
  const a = (
    await s.call("start_task", { prompt: "SLOW 800", repo: s.repo, isolation: "in_place" })
  ).json;
  const b = (await s.call("start_task", { prompt: "after", repo: s.repo, isolation: "in_place" }))
    .json;
  assert.equal(b.status, "queued");
  let v;
  for (let i = 0; i < 10; i++) {
    v = (await s.call("wait_task", { task_id: b.task_id, timeout_s: 5 })).json;
    if (!v.wait_timed_out) break;
  }
  assert.equal(v.status, "idle");
  assert.equal(v.result.text, "echo: after");
  assert.equal((await s.call("get_task", { task_id: a.task_id })).json.status, "idle");
});

test("a message that must resume an exited task queues when no slot is free", async (t) => {
  const s = await server(t);
  const a = (await s.call("start_task", { prompt: "one", repo: s.repo, isolation: "in_place" }))
    .json;
  await until(s, a.task_id, (v) => v.status === "idle");
  await s.call("cancel_task", { task_id: a.task_id });
  const busy = (await s.call("start_task", { prompt: "HANG", repo: s.repo, isolation: "in_place" }))
    .json;
  const r = await s.call("send_message", { task_id: a.task_id, text: "two" });
  assert.equal(r.json.delivery, "queued");
  assert.equal(r.json.task.status, "queued");
  await s.call("cancel_task", { task_id: busy.task_id });
  const done = await until(
    s,
    a.task_id,
    (v) => v.result?.text === "echo: two" && v.status === "idle",
  );
  assert.equal(done.turns, 2);
});

test("ask waits in the queue and still answers", async (t) => {
  const s = await server(t);
  const a = (
    await s.call("start_task", { prompt: "SLOW 1500", repo: s.repo, isolation: "in_place" })
  ).json;
  const r = await s.call(
    "ask",
    { prompt: "queued question", timeout_s: 30 },
    { timeoutMs: 40_000 },
  );
  assert.equal(r.isError, false, r.text);
  assert.equal(r.text, "echo: queued question");
  assert.equal((await s.call("get_task", { task_id: a.task_id })).json.status, "idle");
});

test("cancelling a queued task removes it from the queue", async (t) => {
  const s = await server(t);
  await s.call("start_task", { prompt: "HANG", repo: s.repo, isolation: "in_place" });
  const b = (await s.call("start_task", { prompt: "x", repo: s.repo, isolation: "in_place" })).json;
  const c = await s.call("cancel_task", { task_id: b.task_id });
  assert.equal(c.json.status, "cancelled");
});

test("restart recovery marks dead-runner and stuck tasks interrupted; a message resumes them", async (t) => {
  const box = sandbox({}, { CLAUDECODE_MCP_DISPATCH_MS: "200" });
  let srv = await startServer(box.env);
  const a = (await srv.call("start_task", { prompt: "one", repo: box.repo, isolation: "in_place" }))
    .json;
  for (
    let i = 0;
    i < 40 && (await srv.call("get_task", { task_id: a.task_id })).json.status !== "idle";
    i++
  )
    await sleep(100);
  await srv.call("cancel_task", { task_id: a.task_id });
  srv.stop();
  // Simulate a reboot: the runner record points at a pre-boot process.
  const s = readTask(a.task_id, box.env);
  s.status = "running";
  s.runner = { pid: process.pid, started_at: "2000-01-01T00:00:00.000Z" };
  writeTask(s, box.env);
  // And a second task left "starting" with no runner for a long time.
  const stuckId = "tstuck00000";
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(box.env.CLAUDECODE_MCP_STATE_DIR, "tasks", stuckId), { mode: 0o700 });
  writeTask(
    {
      ...s,
      id: stuckId,
      status: "starting",
      runner: null,
      session_id: "123e4567-e89b-42d3-a456-426614174000",
    },
    box.env,
  );
  const raw = JSON.parse(JSON.stringify(readTask(stuckId, box.env)));
  raw.updated_at = "2000-01-01T00:00:00.000Z";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(box.env.CLAUDECODE_MCP_STATE_DIR, "tasks", stuckId, "task.json"),
    JSON.stringify(raw),
  );

  srv = await startServer(box.env);
  t.after(() => srv.stop());
  assert.equal(readTask(a.task_id, box.env).status, "interrupted");
  assert.equal(readTask(a.task_id, box.env).runner, null);
  assert.equal(readTask(stuckId, box.env).status, "interrupted");
  const r = await srv.call("send_message", { task_id: a.task_id, text: "back" });
  assert.equal(r.json.delivery, "resumed");
  let v;
  for (let i = 0; i < 40; i++) {
    v = (await srv.call("get_task", { task_id: a.task_id })).json;
    if (v.result?.text === "echo: back") break;
    await sleep(100);
  }
  assert.equal(v.result.text, "echo: back");
  await srv.call("cancel_task", { task_id: a.task_id });
});

test("a live rate-limit rejection holds the queue until it resets", async (t) => {
  const s = await server(t, { max_concurrent: 3 });
  const a = (await s.call("start_task", { prompt: "one", repo: s.repo, isolation: "in_place" }))
    .json;
  await until(s, a.task_id, (v) => v.status === "idle");
  await s.call("cancel_task", { task_id: a.task_id });
  const st = readTask(a.task_id, s.env);
  st.rate_limit = {
    status: "rejected",
    rateLimitType: "five_hour",
    resetsAt: Math.floor(Date.now() / 1000) + 3600,
  };
  writeTask(st, s.env);
  const b = (await s.call("start_task", { prompt: "held", repo: s.repo, isolation: "in_place" }))
    .json;
  assert.equal(b.status, "queued");
  assert.ok(b.queue.hold_until);
  const view = (await s.call("get_task", { task_id: a.task_id })).json;
  assert.equal(view.rate_limit_summary.status, "rejected");
  // The reset passes: the queue drains.
  st.rate_limit.resetsAt = Math.floor(Date.now() / 1000) - 1;
  writeTask(st, s.env);
  const done = await until(s, b.task_id, (v) => v.status === "idle");
  assert.equal(done.result.text, "echo: held");
});

test("rate_limit_summary reads the 5-hour and 7-day windows", async () => {
  const { summarizeRateLimit } = await import("../dist/service.js");
  assert.deepEqual(
    summarizeRateLimit({
      status: "allowed_warning",
      resetsAt: 1791493200,
      rateLimitType: "seven_day",
      utilization: 0.63,
      unifiedWindows: { five_hour: { utilization: 0.08 }, seven_day: { utilization: 0.63 } },
    }),
    {
      status: "allowed_warning",
      type: "seven_day",
      utilization: 0.63,
      five_hour_utilization: 0.08,
      seven_day_utilization: 0.63,
      resets_at: new Date(1791493200 * 1000).toISOString(),
    },
  );
  assert.equal(summarizeRateLimit(null), undefined);
});

test("a newer non-rejected rate-limit report clears an older rejection", async (t) => {
  const s = await server(t, { max_concurrent: 3 });
  const a = (await s.call("start_task", { prompt: "one", repo: s.repo, isolation: "in_place" }))
    .json;
  const c = (await s.call("start_task", { prompt: "RATE", repo: s.repo, isolation: "in_place" }))
    .json;
  await until(s, a.task_id, (v) => v.status === "idle");
  await until(s, c.task_id, (v) => v.status === "idle");
  for (const id of [a.task_id, c.task_id]) await s.call("cancel_task", { task_id: id });
  const old = readTask(a.task_id, s.env);
  old.rate_limit = { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 };
  old.last_event_at = "2020-01-01T00:00:00.000Z";
  writeTask(old, s.env);
  const fresh = readTask(c.task_id, s.env);
  fresh.last_event_at = new Date().toISOString();
  writeTask(fresh, s.env);
  const b = (await s.call("start_task", { prompt: "go", repo: s.repo, isolation: "in_place" }))
    .json;
  const done = await until(s, b.task_id, (v) => v.status === "idle");
  assert.equal(done.result.text, "echo: go");
});
