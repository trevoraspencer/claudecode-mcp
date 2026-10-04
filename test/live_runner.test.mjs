// Opt-in live test against the real `claude` CLI: CLAUDECODE_MCP_LIVE=1.
// Uses sonnet because `auto` permission mode falls back to `default` with haiku.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../dist/config.js";
import { buildSpec, launchRunner, requestRunner } from "../dist/launcher.js";
import { ensureStateDir } from "../dist/paths.js";
import { createTask, readTask } from "../dist/task-store.js";

const live = process.env.CLAUDECODE_MCP_LIVE === "1";

test("live: one auto-mode turn with sonnet", { skip: !live, timeout: 180_000 }, async () => {
  const dir = mkdtempSync("/tmp/ccm-live-");
  const workdir = join(dir, "w");
  mkdirSync(workdir);
  const env = {
    ...process.env,
    CLAUDECODE_MCP_STATE_DIR: join(dir, "s"),
    CLAUDECODE_MCP_DEPTH: "",
  };
  delete env.CLAUDECODE_MCP_CLAUDE_BIN;
  ensureStateDir(env);
  const spec = buildSpec(parseConfig({}), { workdir, model: "sonnet", effort: "low" });
  const { id } = createTask({ spec, prompt: "Reply with only the word: pong" }, env);
  try {
    await launchRunner(id, env);
    const deadline = Date.now() + 150_000;
    let s = readTask(id, env);
    while (!["idle", "failed", "timed_out", "rate_limited"].includes(s.status)) {
      assert.ok(Date.now() < deadline, `still ${s.status}`);
      await new Promise((r) => setTimeout(r, 250));
      s = readTask(id, env);
    }
    assert.equal(s.status, "idle", s.error ?? "");
    assert.match(s.result.text, /pong/i);
    assert.equal(s.session_started, true);
  } finally {
    await requestRunner(id, { op: "cancel" }, env, 15_000).catch(() => {});
  }
});

test("live: read-only ask over MCP with haiku", { skip: !live, timeout: 180_000 }, async () => {
  const { sandbox, startServer } = await import("./_mcp.mjs");
  const box = sandbox();
  delete box.env.CLAUDECODE_MCP_CLAUDE_BIN;
  const srv = await startServer(box.env);
  try {
    const r = await srv.call(
      "ask",
      { prompt: "Reply with only the word: pong", model: "haiku", effort: "low", timeout_s: 120 },
      { timeoutMs: 150_000 },
    );
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /pong/i);
  } finally {
    srv.stop();
  }
});

test(
  "live: worktree task writes a file, get_diff sees it, close cleans up",
  { skip: !live, timeout: 240_000 },
  async () => {
    const { sandbox, startServer } = await import("./_mcp.mjs");
    const { existsSync } = await import("node:fs");
    const box = sandbox();
    delete box.env.CLAUDECODE_MCP_CLAUDE_BIN;
    const srv = await startServer(box.env);
    try {
      const start = await srv.call("start_task", {
        prompt:
          "Create a file named hello.txt containing exactly the word hi. Do not commit. Reply done.",
        repo: box.repo,
        model: "sonnet",
        effort: "low",
      });
      assert.equal(start.isError, false, start.text);
      const id = start.json.task_id;
      let v;
      for (let i = 0; i < 40; i++) {
        v = (await srv.call("wait_task", { task_id: id, timeout_s: 5 })).json;
        if (!v.wait_timed_out) break;
      }
      assert.equal(v.status, "idle", v.error ?? "");
      const diff = await srv.call("get_diff", { task_id: id });
      assert.deepEqual(diff.json.untracked, ["hello.txt"]);
      assert.equal(existsSync(`${box.repo}/hello.txt`), false);
      const closed = await srv.call(
        "close_task",
        { task_id: id, action: "delete", force: true },
        { timeoutMs: 30_000 },
      );
      assert.equal(closed.isError, false, closed.text);
      assert.equal(existsSync(v.workspace.worktree), false);
    } finally {
      srv.stop();
    }
  },
);

test(
  "live: a personal skill reaches claude through the generated plugin",
  { skip: !live, timeout: 180_000 },
  async (t) => {
    const { personalSkills } = await import("../dist/profile.js");
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const skill = personalSkills()[0];
    if (!skill) return t.skip("no personal skills on this machine");
    const { sandbox, startServer } = await import("./_mcp.mjs");
    const box = sandbox({ profiles: { worker: { personal_skills: [skill] } } });
    delete box.env.CLAUDECODE_MCP_CLAUDE_BIN;
    const srv = await startServer(box.env);
    try {
      const r = await srv.call(
        "ask",
        { prompt: "Reply with only the word: pong", model: "haiku", effort: "low", timeout_s: 120 },
        { timeoutMs: 150_000 },
      );
      assert.equal(r.isError, false, r.text);
      const tasks = join(box.env.CLAUDECODE_MCP_STATE_DIR, "tasks");
      const [id] = readdirSync(tasks);
      const init = readFileSync(join(tasks, id, "events.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((e) => e.type === "system" && e.subtype === "init");
      assert.ok(init.skills.includes(`claudecode-personal:${skill}`), JSON.stringify(init.skills));
    } finally {
      srv.stop();
    }
  },
);

test("live: interrupt a running turn and steer it", { skip: !live, timeout: 240_000 }, async () => {
  const { sandbox, startServer } = await import("./_mcp.mjs");
  const box = sandbox();
  delete box.env.CLAUDECODE_MCP_CLAUDE_BIN;
  const srv = await startServer(box.env);
  try {
    const start = await srv.call("start_task", {
      prompt: "Write the numbers from 1 to 400 as English words, one per line. Do not use tools.",
      repo: box.repo,
      isolation: "in_place",
      model: "sonnet",
      effort: "low",
    });
    assert.equal(start.isError, false, start.text);
    const id = start.json.task_id;
    // Wait until the turn is producing output, then interrupt it.
    for (let i = 0; i < 100; i++) {
      const v = (await srv.call("get_task", { task_id: id, recent: 3 })).json;
      if (v.recent.some((x) => x.kind === "text")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const r = await srv.call("send_message", {
      task_id: id,
      text: "Stop counting. Reply with only the word: halted",
      interrupt: true,
    });
    assert.equal(r.isError, false, r.text);
    let v;
    for (let i = 0; i < 40; i++) {
      v = (await srv.call("wait_task", { task_id: id, timeout_s: 5 })).json;
      if (!v.wait_timed_out && v.turns >= 2) break;
    }
    assert.match(v.result.text, /halted/i);
    const page = (await srv.call("get_events", { task_id: id, limit: 200 })).json;
    const results = page.events.filter((e) => e.type === "result").map((e) => e.steps[0]?.subtype);
    assert.ok(
      results.includes("error_during_execution") || results.length >= 2,
      JSON.stringify(results),
    );
    await srv.call("cancel_task", { task_id: id });
  } finally {
    srv.stop();
  }
});
