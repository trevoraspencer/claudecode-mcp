// Regression tests for performance hot-path findings:
//   PERF-002 (bounded file reads preserve order)
//   PERF-003 (optional pre-computed baseReal)
//   PERF-004 (child-env caching with invalidation)

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "_fake_claude.mjs");
try {
  chmodSync(STUB, 0o755);
} catch {
  // best-effort
}

const TMP = mkdtempSync(join(tmpdir(), "claudecode-mcp-perf-"));
const OUTFILE = join(TMP, "argv.json");

process.env.CLAUDECODE_MCP_CLAUDE_BIN = STUB;
process.env.CLAUDECODE_MCP_FAKE_OUTFILE = OUTFILE;
process.env.CLAUDECODE_MCP_FAKE_HAS_JSON_SCHEMA = "1";
process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";

// ---------------------------------------------------------------------------
// PERF-002: Bounded file reads preserve prompt order
// ---------------------------------------------------------------------------

const { runClaudePromptWithContext } = await import("../dist/server.js");
const { readFileSync } = await import("node:fs");

const origCwd = process.cwd();

test("PERF-002: multiple bounded file reads preserve prompt order", async () => {
  process.chdir(TMP);
  try {
    // Create three files with distinct content
    writeFileSync(join(TMP, "alpha.txt"), "AAA-content");
    writeFileSync(join(TMP, "beta.txt"), "BBB-content");
    writeFileSync(join(TMP, "gamma.txt"), "CCC-content");

    await runClaudePromptWithContext({
      prompt: "summarize",
      files: ["alpha.txt", "beta.txt", "gamma.txt"],
    });

    const argv = JSON.parse(readFileSync(OUTFILE, "utf8"));
    const prompt = argv[argv.length - 1];

    // Verify all three files are present
    assert.match(prompt, /alpha.txt/);
    assert.match(prompt, /AAA-content/);
    assert.match(prompt, /beta.txt/);
    assert.match(prompt, /BBB-content/);
    assert.match(prompt, /gamma.txt/);
    assert.match(prompt, /CCC-content/);

    // Verify order: alpha must appear before beta, beta before gamma
    const alphaIdx = prompt.indexOf("alpha.txt");
    const betaIdx = prompt.indexOf("beta.txt");
    const gammaIdx = prompt.indexOf("gamma.txt");
    assert.ok(alphaIdx < betaIdx, `alpha (${alphaIdx}) should precede beta (${betaIdx})`);
    assert.ok(betaIdx < gammaIdx, `beta (${betaIdx}) should precede gamma (${gammaIdx})`);
  } finally {
    process.chdir(origCwd);
  }
});

test("PERF-002: bounded reads still reject invalid paths", async () => {
  process.chdir(TMP);
  try {
    writeFileSync(join(TMP, "good.txt"), "good");
    await assert.rejects(
      () =>
        runClaudePromptWithContext({
          prompt: "p",
          files: ["good.txt", "../../etc/passwd"],
        }),
      /failed to include file/,
    );
  } finally {
    process.chdir(origCwd);
  }
});

// ---------------------------------------------------------------------------
// PERF-003: safeReadFileUnderCwd with pre-computed baseReal
// ---------------------------------------------------------------------------

const { safeReadFileUnderCwd } = await import("../dist/path-guard.js");

test("PERF-003: safeReadFileUnderCwd with explicit baseReal reads file correctly", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-perf003-"));
  writeFileSync(join(root, "test.txt"), "hello baseReal");
  const baseReal = await realpath(root);
  const content = await safeReadFileUnderCwd("test.txt", root, baseReal);
  assert.equal(content, "hello baseReal");
});

test("PERF-003: safeReadFileUnderCwd without baseReal still works identically", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-perf003b-"));
  writeFileSync(join(root, "test.txt"), "hello default");
  const contentWith = await safeReadFileUnderCwd("test.txt", root, await realpath(root));
  const contentWithout = await safeReadFileUnderCwd("test.txt", root);
  assert.equal(contentWith, contentWithout);
});

test("PERF-003: safeReadFileUnderCwd with baseReal still rejects escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-perf003c-"));
  const baseReal = await realpath(root);
  await assert.rejects(
    () => safeReadFileUnderCwd("../../etc/passwd", root, baseReal),
    /escapes working directory|not found/,
  );
});

// ---------------------------------------------------------------------------
// PERF-004: Child-env caching with exact-snapshot invalidation
// ---------------------------------------------------------------------------

const { invokeCli, resetEnvCache } = await import("../dist/invoke.js");

// Reset env cache before each test to avoid cross-test contamination
afterEach(() => {
  resetEnvCache();
});

test("PERF-004: env cache returns same filtered env for consecutive calls", async () => {
  process.env._PERF_TEST_VAR = "cached-value";
  process.env.CLAUDECODE_MCP_EXTRA_ENV = "_PERF_TEST_VAR";
  try {
    const result1 = await invokeCli(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({ v: process.env._PERF_TEST_VAR }))"],
      { timeoutMs: 5000 },
    );
    const result2 = await invokeCli(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({ v: process.env._PERF_TEST_VAR }))"],
      { timeoutMs: 5000 },
    );
    // Both calls should see the same env value (cache doesn't break behavior)
    assert.equal(JSON.parse(result1.stdout).v, "cached-value");
    assert.equal(JSON.parse(result2.stdout).v, "cached-value");
  } finally {
    delete process.env._PERF_TEST_VAR;
    delete process.env.CLAUDECODE_MCP_EXTRA_ENV;
    resetEnvCache();
  }
});

test("PERF-004: env cache invalidates when process.env changes", async () => {
  process.env._PERF_MUTATE = "before";
  process.env.CLAUDECODE_MCP_EXTRA_ENV = "_PERF_MUTATE";
  try {
    const result1 = await invokeCli(
      process.execPath,
      ["-e", "process.stdout.write(process.env._PERF_MUTATE || 'undefined')"],
      { timeoutMs: 5000 },
    );
    assert.equal(result1.stdout, "before");

    // Mutate the env
    process.env._PERF_MUTATE = "after";

    const result2 = await invokeCli(
      process.execPath,
      ["-e", "process.stdout.write(process.env._PERF_MUTATE || 'undefined')"],
      { timeoutMs: 5000 },
    );
    assert.equal(result2.stdout, "after", "cache should invalidate after env mutation");
  } finally {
    delete process.env._PERF_MUTATE;
    delete process.env.CLAUDECODE_MCP_EXTRA_ENV;
    resetEnvCache();
  }
});

test("PERF-004: env cache invalidates when env var is deleted", async () => {
  process.env._PERF_DELETEME = "exists";
  process.env.CLAUDECODE_MCP_EXTRA_ENV = "_PERF_DELETEME";
  try {
    const result1 = await invokeCli(
      process.execPath,
      ["-e", "process.stdout.write(process.env._PERF_DELETEME || 'undefined')"],
      { timeoutMs: 5000 },
    );
    assert.equal(result1.stdout, "exists");

    delete process.env._PERF_DELETEME;

    const result2 = await invokeCli(
      process.execPath,
      ["-e", "process.stdout.write(process.env._PERF_DELETEME || 'undefined')"],
      { timeoutMs: 5000 },
    );
    assert.equal(
      result2.stdout,
      "undefined",
      "deleted env var should not leak through stale cache",
    );
  } finally {
    delete process.env.CLAUDECODE_MCP_EXTRA_ENV;
    resetEnvCache();
  }
});

test("PERF-004: EXTRA_ENV forwarded vars update after cache invalidation", async () => {
  process.env._PERF_EXTRA = "first";
  process.env.CLAUDECODE_MCP_EXTRA_ENV = "_PERF_EXTRA";
  try {
    const result1 = await invokeCli(
      process.execPath,
      ["-e", "process.stdout.write(process.env._PERF_EXTRA || 'undefined')"],
      { timeoutMs: 5000 },
    );
    assert.equal(result1.stdout, "first");

    process.env._PERF_EXTRA = "second";

    const result2 = await invokeCli(
      process.execPath,
      ["-e", "process.stdout.write(process.env._PERF_EXTRA || 'undefined')"],
      { timeoutMs: 5000 },
    );
    assert.equal(result2.stdout, "second", "EXTRA_ENV var should update after env mutation");
  } finally {
    delete process.env._PERF_EXTRA;
    delete process.env.CLAUDECODE_MCP_EXTRA_ENV;
    resetEnvCache();
  }
});
