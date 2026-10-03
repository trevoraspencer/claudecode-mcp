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
