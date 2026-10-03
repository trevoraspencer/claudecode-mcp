import { test } from "node:test";
import assert from "node:assert/strict";

import { ArgTooLargeError, buildClaudeArgs } from "../dist/claude-args.js";
import { parseConfig } from "../dist/config.js";
import { buildSpec } from "../dist/launcher.js";

const SID = "123e4567-e89b-42d3-a456-426614174000";
const spec = (config = {}, input = {}) =>
  buildSpec(parseConfig(config), { workdir: "/tmp", ...input });
const val = (args, flag) => args[args.indexOf(flag) + 1];

test("new session vs resume", () => {
  const a = buildClaudeArgs(spec(), { id: SID, resume: false });
  assert.equal(val(a, "--session-id"), SID);
  assert.equal(a.includes("--resume"), false);
  const b = buildClaudeArgs(spec(), { id: SID, resume: true });
  assert.equal(val(b, "--resume"), SID);
  assert.equal(b.includes("--session-id"), false);
});

test("default profile flags", () => {
  const a = buildClaudeArgs(spec(), { id: SID, resume: false });
  assert.equal(val(a, "--permission-mode"), "auto");
  assert.equal(val(a, "--permission-prompts"), "none");
  assert.equal(val(a, "--setting-sources"), "project,local");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(val(a, "--mcp-config"), '{"mcpServers":{}}');
  assert.equal(a.includes("--model"), false);
  assert.equal(a.includes("--effort"), false);
});

test("profile and caller choices", () => {
  const config = {
    profiles: {
      worker: {
        permission_mode: "bypassPermissions",
        setting_sources: [],
        model: "opus",
        effort: "high",
        mcp_servers: { gh: { command: "gh-mcp" } },
      },
    },
  };
  const a = buildClaudeArgs(spec(config), { id: SID, resume: false });
  assert.equal(val(a, "--permission-mode"), "bypassPermissions");
  assert.equal(val(a, "--setting-sources"), "");
  assert.equal(val(a, "--model"), "opus");
  assert.equal(val(a, "--effort"), "high");
  assert.deepEqual(JSON.parse(val(a, "--mcp-config")).mcpServers.gh, { command: "gh-mcp" });
  const b = buildClaudeArgs(
    spec(config, {
      model: "sonnet",
      effort: "low",
      system_prompt: "be brief",
      output_schema: { type: "object" },
    }),
    { id: SID, resume: false },
  );
  assert.equal(val(b, "--model"), "sonnet");
  assert.equal(val(b, "--effort"), "low");
  assert.equal(val(b, "--append-system-prompt"), "be brief");
  assert.equal(val(b, "--json-schema"), '{"type":"object"}');
});

test("inherit_user_mcp drops the strict MCP flags", () => {
  const a = buildClaudeArgs(spec({ profiles: { worker: { inherit_user_mcp: true } } }), {
    id: SID,
    resume: false,
  });
  assert.equal(a.includes("--strict-mcp-config"), false);
  assert.equal(a.includes("--mcp-config"), false);
});

test("oversized argv values are refused", () => {
  assert.throws(
    () =>
      buildClaudeArgs(spec({}, { system_prompt: "x".repeat(101 * 1024) }), {
        id: SID,
        resume: false,
      }),
    ArgTooLargeError,
  );
});

test("buildSpec converts limits and only lets callers lower max_minutes", () => {
  const s = spec({ max_minutes: 60, stall_minutes: 5, idle_minutes: 2, max_events_mb: 3 });
  assert.equal(s.max_turn_ms, 60 * 60_000);
  assert.equal(s.stall_ms, 5 * 60_000);
  assert.equal(s.idle_ms, 2 * 60_000);
  assert.equal(s.max_event_bytes, 3 * 1024 * 1024);
  assert.equal(spec({ max_minutes: 60 }, { max_minutes: 10 }).max_turn_ms, 10 * 60_000);
  assert.equal(spec({ max_minutes: 60 }, { max_minutes: 600 }).max_turn_ms, 60 * 60_000);
  for (const bad of [0, -5, Number.NaN, Infinity]) {
    assert.equal(spec({ max_minutes: 60 }, { max_minutes: bad }).max_turn_ms, 60 * 60_000, bad);
  }
});
