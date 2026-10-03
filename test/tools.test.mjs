// MCP tools end to end: built server over stdio, real runners, fake claude.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { sandbox, startServer } from "./_mcp.mjs";

async function server(t, config, envExtra) {
  const box = sandbox(config, envExtra);
  const srv = await startServer(box.env);
  t.after(async () => {
    const list = await srv.call("list_tasks", {});
    for (const task of list.json ?? []) {
      if (["running", "idle", "stalled", "starting"].includes(task.status)) {
        await srv.call("cancel_task", { task_id: task.task_id }, { timeoutMs: 30_000 });
      }
    }
    srv.stop();
  });
  const lastArgv = () =>
    readFileSync(box.env.CLAUDECODE_MCP_FAKE_ARGV_OUT, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .at(-1);
  return { ...box, ...srv, lastArgv };
}

async function waitIdle(s, id, check = () => true) {
  for (let i = 0; i < 40; i++) {
    const r = await s.call("wait_task", { task_id: id, timeout_s: 5 });
    if (!r.json.wait_timed_out && check(r.json)) return r.json;
  }
  throw new Error("task never settled");
}

test("tools/list shows the task tools", async (t) => {
  const s = await server(t);
  const list = await s.request("tools/list", {});
  assert.deepEqual(list.result.tools.map((x) => x.name).sort(), [
    "ask",
    "cancel_task",
    "close_task",
    "get_diff",
    "get_events",
    "get_task",
    "list_tasks",
    "send_message",
    "start_task",
    "wait_task",
  ]);
});

test("start_task, wait_task, get_task: one turn end to end", async (t) => {
  const s = await server(t);
  const start = await s.call("start_task", { prompt: "hello", repo: s.repo, name: "demo" });
  assert.equal(start.isError, false, start.text);
  const id = start.json.task_id;
  assert.match(id, /^t[0-9a-z]{10}$/);
  assert.match(start.json.workdir, /\/repo\/\.claude\/worktrees\/t[0-9a-z]{10}$/);
  assert.equal(start.json.workspace.isolation, "worktree");
  const done = await waitIdle(s, id);
  assert.equal(done.status, "idle");
  assert.equal(done.result.text, "echo: hello");
  assert.equal(done.name, "demo");
  assert.deepEqual(
    done.recent.map((x) => x.kind),
    ["turn_start", "text", "result"],
  );
  assert.match(
    done.takeover.command,
    /^cd '.*\/worktrees\/t[0-9a-z]{10}' && claude --resume [0-9a-f-]{36}$/,
  );
  assert.ok(done.takeover.note, "runner alive: take-over note present");
  const got = await s.call("get_task", { task_id: id, recent: 1 });
  assert.equal(got.json.recent.length, 1);
});

test("start_task refuses repos outside allowed_roots and unknown profiles", async (t) => {
  const s = await server(t);
  const outside = await s.call("start_task", { prompt: "x", repo: "/" });
  assert.equal(outside.isError, true);
  assert.match(outside.text, /outside allowed_roots/);
  const missing = await s.call("start_task", { prompt: "x", repo: s.repo + "/nope" });
  assert.match(missing.text, /does not exist/);
  const relative = await s.call("start_task", { prompt: "x", repo: "repo" });
  assert.match(relative.text, /absolute/);
  const profile = await s.call("start_task", { prompt: "x", repo: s.repo, profile: "nope" });
  assert.match(profile.text, /unknown profile/);
  const bad = await s.call("start_task", { prompt: "x", repo: s.repo, isolation: "elsewhere" });
  assert.equal(bad.isError, true);
});

test("send_message: idle turn, interrupt, and resume after cancel", async (t) => {
  const s = await server(t);
  const id = (await s.call("start_task", { prompt: "one", repo: s.repo })).json.task_id;
  await waitIdle(s, id);

  const two = await s.call("send_message", { task_id: id, text: "two" });
  assert.equal(two.json.delivery, "started");
  await waitIdle(s, id, (v) => v.result?.text === "echo: two");

  await s.call("send_message", { task_id: id, text: "SLOW 30000" });
  const intr = await s.call("send_message", { task_id: id, text: "instead", interrupt: true });
  assert.equal(intr.json.delivery, "interrupting");
  await waitIdle(s, id, (v) => v.result?.text === "echo: instead");

  const cancelled = await s.call("cancel_task", { task_id: id }, { timeoutMs: 30_000 });
  assert.equal(cancelled.json.status, "cancelled");
  assert.equal(cancelled.json.runner_alive, false);
  const resumed = await s.call("send_message", { task_id: id, text: "back" });
  assert.equal(resumed.json.delivery, "resumed");
  await waitIdle(s, id, (v) => v.result?.text === "echo: back");
  assert.ok(s.lastArgv().includes("--resume"));
});

test("wait_task returns wait_timed_out on a long turn", async (t) => {
  const s = await server(t);
  const id = (await s.call("start_task", { prompt: "HANG", repo: s.repo })).json.task_id;
  const r = await s.call("wait_task", { task_id: id, timeout_s: 1 });
  assert.equal(r.json.wait_timed_out, true);
  assert.equal(r.json.status, "running");
});

test("get_events pages with a byte cursor", async (t) => {
  const s = await server(t);
  const id = (await s.call("start_task", { prompt: "hello", repo: s.repo })).json.task_id;
  await waitIdle(s, id);
  const p1 = await s.call("get_events", { task_id: id, limit: 2 });
  assert.deepEqual(
    p1.json.events.map((e) => e.type),
    ["system", "assistant"],
  );
  assert.equal(p1.json.eof, false);
  const p2 = await s.call("get_events", { task_id: id, cursor: p1.json.next_cursor });
  assert.deepEqual(
    p2.json.events.map((e) => e.type),
    ["result"],
  );
  assert.equal(p2.json.eof, true);
  assert.equal(p2.json.events[0].steps[0].text, "echo: hello");
});

test("list_tasks filters by status and repo", async (t) => {
  const s = await server(t);
  const a = (await s.call("start_task", { prompt: "a", repo: s.repo })).json.task_id;
  await waitIdle(s, a);
  const b = (await s.call("start_task", { prompt: "HANG", repo: s.repo })).json.task_id;
  const idle = await s.call("list_tasks", { status: "idle" });
  assert.deepEqual(
    idle.json.map((x) => x.task_id),
    [a],
  );
  assert.equal(idle.json[0].result_preview, "echo: a");
  const all = await s.call("list_tasks", { repo: s.repo });
  assert.deepEqual(new Set(all.json.map((x) => x.task_id)), new Set([a, b]));
  assert.deepEqual((await s.call("list_tasks", { repo: "/nonexistent" })).json, []);
});

test("unknown task ids are errors", async (t) => {
  const s = await server(t);
  for (const id of ["t0000000000", "../../etc"]) {
    const r = await s.call("get_task", { task_id: id });
    assert.equal(r.isError, true);
    assert.match(r.text, /task not found/);
  }
});

test("ask without repo: read-only, temp folder, closed after", async (t) => {
  const s = await server(t);
  const r = await s.call("ask", { prompt: "review this" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.text, "echo: review this");
  const args = s.lastArgv();
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.deepEqual(args.slice(args.indexOf("--disallowedTools") + 1), [
    "Edit",
    "Write",
    "NotebookEdit",
  ]);
  assert.match(args[args.indexOf("--append-system-prompt") + 1], /read-only/);
  const [task] = (await s.call("list_tasks", {})).json;
  assert.equal(task.status, "closed");
  assert.equal(task.name, "ask");
  assert.equal(existsSync(task.workdir), false, "temp folder removed");
});

test("ask writable in a repo uses the profile's mode", async (t) => {
  const s = await server(t);
  const r = await s.call("ask", { prompt: "fix it", repo: s.repo, writable: true });
  assert.equal(r.isError, false, r.text);
  const args = s.lastArgv();
  assert.equal(args[args.indexOf("--permission-mode") + 1], "auto");
  assert.equal(args.includes("--disallowedTools"), false);
});

test("ask errors are redacted; ask timeouts close the task", async (t) => {
  const s = await server(t);
  const crash = await s.call("ask", { prompt: "CRASH" });
  assert.equal(crash.isError, true);
  assert.match(crash.text, /exited unexpectedly/);
  assert.doesNotMatch(crash.text, /FAKESECRET/);
  const slow = await s.call("ask", { prompt: "HANG", timeout_s: 1 }, { timeoutMs: 30_000 });
  assert.equal(slow.isError, true);
  assert.match(slow.text, /timed out after 1 s/);
  const tasks = (await s.call("list_tasks", {})).json;
  assert.ok(tasks.every((x) => x.status === "closed"));
});

test("ask sends progress notifications when the client asks for them", async (t) => {
  const s = await server(t);
  const r = await s.call(
    "ask",
    { prompt: "SLOW 11000", timeout_s: 30 },
    { progressToken: "p1", timeoutMs: 30_000 },
  );
  assert.equal(r.isError, false, r.text);
  const progress = s.notifications.filter((n) => n.method === "notifications/progress");
  assert.ok(progress.length >= 1);
  assert.equal(progress[0].params.progressToken, "p1");
});

test("task tools refuse inside a delegated task (depth guard)", async (t) => {
  const s = await server(t, {}, { CLAUDECODE_MCP_DEPTH: "1" });
  for (const [tool, args] of [
    ["start_task", { prompt: "x", repo: "/tmp" }],
    ["ask", { prompt: "x" }],
    ["send_message", { task_id: "t0000000000", text: "x" }],
  ]) {
    const r = await s.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(r.text, /recursive delegation/, tool);
  }
});

test("an old claude CLI is refused before any task starts", async (t) => {
  const s = await server(t, {}, { CLAUDECODE_MCP_FAKE_VERSION: "2.0.0 (Claude Code)" });
  const r = await s.call("start_task", { prompt: "x", repo: s.repo });
  assert.equal(r.isError, true);
  assert.match(r.text, /too old/);
  assert.deepEqual((await s.call("list_tasks", {})).json, []);
});
