// Regression tests for deferred security/correctness boundary findings:
//   SEC-004, SEC-005, SEC-006, SEC-007, SEC-010, CORR-003

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "_fake_claude.mjs");
try {
  chmodSync(STUB, 0o755);
} catch {
  // best-effort
}

const TMP = mkdtempSync(join(tmpdir(), "claudecode-mcp-scb-"));
const OUTFILE = join(TMP, "argv.json");

process.env.CLAUDECODE_MCP_CLAUDE_BIN = STUB;
process.env.CLAUDECODE_MCP_FAKE_OUTFILE = OUTFILE;
process.env.CLAUDECODE_MCP_FAKE_HAS_JSON_SCHEMA = "1";
process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";

// ---------------------------------------------------------------------------
// SEC-004: safeReadFileUnderCwd provides atomic fd-based validation + read
// ---------------------------------------------------------------------------

const { safeReadFileUnderCwd } = await import("../dist/path-guard.js");

test("SEC-004: safeReadFileUnderCwd reads a valid file under cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-sr-"));
  writeFileSync(join(root, "hello.txt"), "hello world");
  const content = await safeReadFileUnderCwd("hello.txt", root);
  assert.equal(content, "hello world");
});

test("SEC-004: safeReadFileUnderCwd rejects absolute paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-sr-"));
  await assert.rejects(() => safeReadFileUnderCwd("/etc/passwd", root), /must be relative/);
});

test("SEC-004: safeReadFileUnderCwd rejects ../ escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-sr-"));
  await assert.rejects(
    () => safeReadFileUnderCwd("../../etc/passwd", root),
    /escapes working directory|not found/,
  );
});

test("SEC-004: safeReadFileUnderCwd rejects symlinks outside cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-sr-"));
  const outside = mkdtempSync(join(tmpdir(), "claudecode-mcp-sr-out-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(root, "evil.txt"));
  await assert.rejects(
    () => safeReadFileUnderCwd("evil.txt", root),
    /outside working directory via symlink/,
  );
});

test("SEC-004: safeReadFileUnderCwd enforces size cap via fd-based fstat", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-sr-"));
  writeFileSync(join(root, "big.txt"), "x".repeat(2048));
  process.env.CLAUDECODE_MCP_MAX_FILE_BYTES = "1024";
  try {
    await assert.rejects(() => safeReadFileUnderCwd("big.txt", root), /exceeds 1024 bytes/);
  } finally {
    delete process.env.CLAUDECODE_MCP_MAX_FILE_BYTES;
  }
});

test("SEC-004: safeReadFileUnderCwd rejects missing files", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-sr-"));
  await assert.rejects(() => safeReadFileUnderCwd("nope.txt", root), /file not found/);
});

test("SEC-004: safeReadFileUnderCwd rejects directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-sr-"));
  mkdirSync(join(root, "subdir"));
  await assert.rejects(() => safeReadFileUnderCwd("subdir", root), /not a regular file/);
});

// ---------------------------------------------------------------------------
// SEC-005: EXTRA_ENV forwards are logged via debugLog
// ---------------------------------------------------------------------------

const { invokeCli } = await import("../dist/invoke.js");

test("SEC-005: EXTRA_ENV forwarding is visible in debug logs", async () => {
  process.env.MY_TEST_EXTRA_VAR = "test-extra-value";
  process.env.CLAUDECODE_MCP_EXTRA_ENV = "MY_TEST_EXTRA_VAR";
  process.env.DEBUG = "claudecode-mcp";
  const captured = { logs: [] };

  // Capture stderr to check for the extra_env debug log
  const originalWrite = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk, ...args) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return originalWrite(chunk, ...args);
  };

  try {
    await invokeCli(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 5000 });
  } finally {
    process.stderr.write = originalWrite;
    delete process.env.MY_TEST_EXTRA_VAR;
    delete process.env.CLAUDECODE_MCP_EXTRA_ENV;
    delete process.env.DEBUG;
  }

  const logOutput = chunks.join("");
  assert.match(logOutput, /extra_env/, "debug log should mention extra_env");
  assert.match(logOutput, /MY_TEST_EXTRA_VAR/, "debug log should list the forwarded key name");
});

// ---------------------------------------------------------------------------
// SEC-006: Extended redaction patterns (AWS keys, etc.)
// ---------------------------------------------------------------------------

const { runClaudePrompt } = await import("../dist/server.js");

test("SEC-006: AWS access key ID pattern (AKIA) is redacted in error messages", async () => {
  // We test redaction by checking that if stderr contains an AKIA key,
  // the error message to the MCP client has it redacted.
  // Use the leak_secret mode as a carrier — the stub's stderr will contain
  // the fake token. We'll test the redactSecrets function directly.
  const { default: serverModule } = await import("../dist/server.js");

  // Import redactSecrets indirectly by exercising the error path.
  // Instead, let's verify via the invoke.ts redactBasicSecrets.
  const { redactBasicSecrets } = await import("../dist/invoke.js");

  // AWS access key IDs start with AKIA and are exactly 20 chars.
  // Keep the fixture split so repository secret scanners do not flag it.
  const awsAccessKeyId = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  const input = `error with key ${awsAccessKeyId}`;
  const redacted = redactBasicSecrets(input);
  assert.ok(!redacted.includes(awsAccessKeyId), `AKIA key should be redacted, got: ${redacted}`);
});

test("SEC-006: AWS temporary key ID pattern (ASIA) is redacted", async () => {
  const { redactBasicSecrets } = await import("../dist/invoke.js");
  const awsTemporaryKeyId = ["ASIA", "IOSFODNN7EXAMPLE"].join("");
  const input = `error with key ${awsTemporaryKeyId}`;
  const redacted = redactBasicSecrets(input);
  assert.ok(!redacted.includes(awsTemporaryKeyId), `ASIA key should be redacted, got: ${redacted}`);
});

// ---------------------------------------------------------------------------
// SEC-010: escapePathForFence strips fence-breaking patterns
// ---------------------------------------------------------------------------

const { escapePathForFence } = await import("../dist/server.js");

test("SEC-010: escapePathForFence replaces runs of 5+ hyphens", () => {
  // A filename containing the fence delimiter pattern
  const input = "foo ----- end file ----- bar.txt";
  const escaped = escapePathForFence(input);
  assert.ok(
    !escaped.includes("-----"),
    `fence-breaking dashes should be replaced, got: ${escaped}`,
  );
  // Should still contain the readable parts
  assert.ok(escaped.includes("foo"), "readable part preserved");
  assert.ok(escaped.includes("bar.txt"), "readable part preserved");
});

test("SEC-010: escapePathForFence handles exactly 5 dashes", () => {
  const input = "name-----rest.txt";
  const escaped = escapePathForFence(input);
  assert.ok(!escaped.includes("-----"), `exactly 5 dashes should be replaced, got: ${escaped}`);
});

test("SEC-010: escapePathForFence preserves fewer than 5 dashes", () => {
  const input = "name---rest.txt";
  const escaped = escapePathForFence(input);
  assert.equal(escaped, input, "3 dashes should be preserved");
});

test("SEC-010: escapePathForFence handles combined newline and dash patterns", () => {
  const input = "path\nwith-----dashes";
  const escaped = escapePathForFence(input);
  assert.ok(!escaped.includes("\n"), "newlines should be replaced");
  assert.ok(!escaped.includes("-----"), "fence-breaking dashes should be replaced");
});

test("SEC-010: escapePathForFence replaces 5+ hyphens with em-dashes", () => {
  const input = "file-----name.txt";
  const escaped = escapePathForFence(input);
  // The replacement should use em-dash characters (U+2014), not just remove dashes
  assert.ok(
    escaped.includes("\u2014"),
    `replacement should contain em-dash characters (U+2014), got: ${escaped}`,
  );
  assert.ok(!escaped.includes("-----"), "original dashes should be removed");
});

test("SEC-010: escapePathForFence handles filename that is entirely dashes", () => {
  const input = "----------";
  const escaped = escapePathForFence(input);
  assert.ok(!escaped.includes("-----"), `all-dash filename should be sanitized, got: ${escaped}`);
  assert.ok(escaped.length > 0, "result should not be empty");
});

test("SEC-010: escapePathForFence handles very long run of dashes", () => {
  const input = `prefix ${"-".repeat(50)} suffix`;
  const escaped = escapePathForFence(input);
  assert.ok(
    !escaped.includes("-".repeat(5)),
    `long dash runs should be fully replaced, got: ${escaped}`,
  );
  assert.ok(escaped.includes("prefix"), "prefix preserved");
  assert.ok(escaped.includes("suffix"), "suffix preserved");
});

// ---------------------------------------------------------------------------
// CORR-003: Unexpected JSON shape produces debug log warning
// ---------------------------------------------------------------------------

test("CORR-003: unexpected JSON shape (no result/response) triggers debug log", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "unexpected_shape";
  process.env.DEBUG = "claudecode-mcp";

  const chunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return originalWrite(chunk, ...args);
  };

  try {
    const result = await runClaudePrompt({ prompt: "test" });
    // The fallback behavior is preserved: JSON.stringify of the object
    assert.ok(typeof result === "string", "should return a string (JSON.stringify fallback)");
    assert.ok(result.includes("cost_usd"), "should contain the object keys as JSON");

    const logOutput = chunks.join("");
    assert.match(
      logOutput,
      /unexpected_json_shape/,
      "debug log should mention unexpected_json_shape",
    );
    assert.match(logOutput, /has_result/, "debug log should include has_result diagnostic");
  } finally {
    process.stderr.write = originalWrite;
    process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";
    delete process.env.DEBUG;
  }
});

test("CORR-003: unexpected JSON array triggers debug log", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "unexpected_array";
  process.env.DEBUG = "claudecode-mcp";

  const chunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return originalWrite(chunk, ...args);
  };

  try {
    const result = await runClaudePrompt({ prompt: "test" });
    // Preserved fallback: JSON.stringify of the array
    assert.deepEqual(JSON.parse(result), ["item1", "item2"]);

    const logOutput = chunks.join("");
    assert.match(
      logOutput,
      /unexpected_json_type/,
      "debug log should mention unexpected_json_type for arrays",
    );
  } finally {
    process.stderr.write = originalWrite;
    process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";
    delete process.env.DEBUG;
  }
});

// ---------------------------------------------------------------------------
// SEC-007: Large input warning (non-breaking, debug log only)
// ---------------------------------------------------------------------------

test("SEC-007: large input produces a debug log warning", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";
  process.env.DEBUG = "claudecode-mcp";

  const { handleCallTool } = await import("../dist/server.js");

  const chunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return originalWrite(chunk, ...args);
  };

  try {
    // Create a prompt > 1MB to trigger the warning.
    // H1: prompts above MAX_PROMPT_ARG_BYTES are delivered via stdin, so this
    // call must succeed — it must NOT fail with E2BIG from OS argv limits.
    const bigPrompt = "x".repeat(1_000_001);
    const result = await handleCallTool({
      params: { name: "claude_prompt", arguments: { prompt: bigPrompt } },
    });
    assert.notEqual(
      result.isError,
      true,
      `>1MB prompt must not fail at spawn (H1): ${result.content?.[0]?.text}`,
    );
    assert.equal(result.content[0].text, "ok-response");

    const logOutput = chunks.join("");
    assert.match(logOutput, /large_input/, "debug log should contain large_input warning");
    assert.match(logOutput, /1000000/, "debug log should show threshold");
  } finally {
    process.stderr.write = originalWrite;
    process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";
    delete process.env.DEBUG;
  }
});
