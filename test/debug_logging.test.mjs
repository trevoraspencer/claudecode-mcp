// DEBUG-gated structured logging. When DEBUG includes "claudecode-mcp" the
// server should emit one JSON line per spawn / call. Without it, nothing is
// logged. Prompt bodies must NEVER appear in the log output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
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

const TMP = mkdtempSync(join(tmpdir(), "claudecode-mcp-debug-"));
process.env.CLAUDECODE_MCP_CLAUDE_BIN = STUB;
process.env.CLAUDECODE_MCP_FAKE_OUTFILE = join(TMP, "argv.json");
process.env.CLAUDECODE_MCP_FAKE_HAS_JSON_SCHEMA = "1";
process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";

const { handleCallTool, debugEnabled } = await import("../dist/server.js");

test("debugEnabled is false without DEBUG", () => {
  delete process.env.DEBUG;
  assert.equal(debugEnabled(), false);
});

test("debugEnabled is true when DEBUG includes claudecode-mcp", () => {
  process.env.DEBUG = "foo,claudecode-mcp,bar";
  try {
    assert.equal(debugEnabled(), true);
  } finally {
    delete process.env.DEBUG;
  }
});

test("DEBUG=claudecode-mcp emits structured logs on stderr — and no prompt bodies", async () => {
  // Capture stderr by hijacking process.stderr.write for the call.
  process.env.DEBUG = "claudecode-mcp";
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return origWrite(chunk, ...rest);
  };
  try {
    const SECRET_PROMPT = "TOPSECRET-PROMPT-BODY-zzz";
    const res = await handleCallTool({
      params: { name: "claude_prompt", arguments: { prompt: SECRET_PROMPT } },
    });
    assert.equal(res.isError, undefined);
    const joined = captured.join("");
    assert.ok(/"tag":"claudecode-mcp"/.test(joined), "expected debug tag in stderr");
    assert.ok(/"phase":"call"/.test(joined));
    assert.ok(/"phase":"spawn"/.test(joined));
    assert.ok(/"phase":"call_done"/.test(joined));
    assert.ok(
      !joined.includes(SECRET_PROMPT),
      `prompt body must NOT appear in logs, got: ${joined.slice(0, 400)}`,
    );
  } finally {
    process.stderr.write = origWrite;
    delete process.env.DEBUG;
  }
});

test("without DEBUG, no [claudecode-mcp] logs leak", async () => {
  delete process.env.DEBUG;
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return origWrite(chunk, ...rest);
  };
  try {
    await handleCallTool({
      params: { name: "claude_prompt", arguments: { prompt: "hi" } },
    });
    const joined = captured.join("");
    assert.ok(
      !/"tag":"claudecode-mcp"/.test(joined),
      `no debug logs expected, got: ${joined.slice(0, 200)}`,
    );
  } finally {
    process.stderr.write = origWrite;
  }
});

// OBS-010: Structured log field correctness — verify duration_ms, exit_code,
// stdout_bytes are present and have the expected types.
test("DEBUG logs contain correctly-typed structured fields (duration_ms, exit_code, stdout_bytes)", async () => {
  process.env.DEBUG = "claudecode-mcp";
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return origWrite(chunk, ...rest);
  };
  try {
    await handleCallTool({
      params: { name: "claude_prompt", arguments: { prompt: "test-fields" } },
    });
    const lines = captured
      .join("")
      .split("\n")
      .filter((l) => l.trim());
    const exitLine = lines.find((l) => l.includes('"phase":"exit"'));
    assert.ok(exitLine, "expected an exit phase log line");
    const exitObj = JSON.parse(exitLine);
    assert.equal(typeof exitObj.duration_ms, "number", "duration_ms should be a number");
    assert.ok(exitObj.duration_ms >= 0, "duration_ms should be non-negative");
    assert.equal(exitObj.exit_code, 0, "exit_code should be 0 for success");
    assert.equal(typeof exitObj.stdout_bytes, "number", "stdout_bytes should be a number");
    assert.ok(exitObj.stdout_bytes >= 0, "stdout_bytes should be non-negative");
    assert.equal(typeof exitObj.ts, "string", "ts should be a string");
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(exitObj.ts), "ts should be ISO format");
  } finally {
    process.stderr.write = origWrite;
    delete process.env.DEBUG;
  }
});

// OBS-011: stderr diagnostics — the bounded preview emitted after a non-zero
// exit must be sanitized before debugLog receives it.
test("non-zero exit logs stderr snippet via structured debugLog", async () => {
  process.env.DEBUG = "claudecode-mcp";
  process.env.CLAUDECODE_MCP_FAKE_MODE = "leak_secret";
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return origWrite(chunk, ...rest);
  };
  try {
    await handleCallTool({
      params: { name: "claude_prompt", arguments: { prompt: "x" } },
    });
    const lines = captured
      .join("")
      .split("\n")
      .filter((l) => l.trim());
    // Find the subprocess_error log (from exitError)
    const errLine = lines.find((l) => l.includes('"phase":"subprocess_error"'));
    assert.ok(errLine, "expected subprocess_error phase log line");
    const errObj = JSON.parse(errLine);
    assert.equal(errObj.exit_code, 1, "exit_code should be 1");
    // stderr_snippet should be redacted (no raw FAKETOKEN)
    assert.ok(!errObj.stderr_snippet.includes("FAKETOKEN"), "stderr_snippet should be redacted");
    assert.ok(
      errObj.stderr_snippet.includes("sk-ant-***"),
      "stderr_snippet should show redacted token",
    );
  } finally {
    process.stderr.write = origWrite;
    delete process.env.DEBUG;
    process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";
  }
});
