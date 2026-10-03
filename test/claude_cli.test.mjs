import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkClaudeVersion,
  ClaudeVersionError,
  compareVersions,
  getClaudeBin,
  MIN_CLAUDE_VERSION,
  parseVersion,
} from "../dist/claude-cli.js";

const STUB = join(dirname(fileURLToPath(import.meta.url)), "_fake_claude.mjs");

test("parseVersion reads the leading X.Y.Z", () => {
  assert.deepEqual(parseVersion("2.1.288 (Claude Code)\n"), [2, 1, 288]);
  assert.deepEqual(parseVersion("v3.0.0"), [3, 0, 0]);
  assert.equal(parseVersion("Claude Code 2.1.288"), null);
  assert.equal(parseVersion("2.1"), null);
  assert.equal(parseVersion("2.1.288.4"), null);
});

test("compareVersions orders numerically", () => {
  assert.equal(compareVersions([2, 1, 287], [2, 1, 287]), 0);
  assert.equal(compareVersions([2, 1, 286], [2, 1, 287]), -1);
  assert.equal(compareVersions([2, 10, 0], [2, 9, 999]), 1);
});

test("getClaudeBin defaults to claude", () => {
  assert.equal(getClaudeBin({}), "claude");
  assert.equal(getClaudeBin({ CLAUDECODE_MCP_CLAUDE_BIN: "/x/claude" }), "/x/claude");
});

function stubEnv(extra = {}) {
  return { ...process.env, CLAUDECODE_MCP_CLAUDE_BIN: STUB, ...extra };
}

test("accepts the minimum version and newer", async () => {
  assert.equal(
    await checkClaudeVersion(stubEnv({ CLAUDECODE_MCP_FAKE_VERSION: MIN_CLAUDE_VERSION })),
    MIN_CLAUDE_VERSION,
  );
  assert.equal(await checkClaudeVersion(stubEnv()), "2.1.288");
});

test("rejects an older CLI", async () => {
  await assert.rejects(
    checkClaudeVersion(stubEnv({ CLAUDECODE_MCP_FAKE_VERSION: "2.1.286 (Claude Code)" })),
    (err) => err instanceof ClaudeVersionError && /too old/.test(err.message),
  );
});

test("rejects unparseable output and a failing CLI", async () => {
  await assert.rejects(
    checkClaudeVersion(stubEnv({ CLAUDECODE_MCP_FAKE_VERSION: "dev build" })),
    /cannot parse/,
  );
  await assert.rejects(checkClaudeVersion(stubEnv({ CLAUDECODE_MCP_FAKE_EXIT: "3" })), /failed/);
});

test("a missing binary gives an install hint", async () => {
  await assert.rejects(
    checkClaudeVersion({ ...process.env, CLAUDECODE_MCP_CLAUDE_BIN: "/nonexistent/claude" }),
    (err) => err instanceof ClaudeVersionError && /not found/.test(err.message),
  );
});

test("the version probe runs with the filtered child env", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "claudecode-mcp-env-")), "env.json");
  await checkClaudeVersion(
    stubEnv({ CLAUDECODE_MCP_FAKE_ENV_OUT: out, CLAUDECODE: "1", SOME_SECRET: "x" }),
  );
  const seen = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(seen.CLAUDECODE, undefined);
  assert.equal(seen.SOME_SECRET, undefined);
  assert.equal(seen.CLAUDECODE_MCP_DEPTH, "1");
});
