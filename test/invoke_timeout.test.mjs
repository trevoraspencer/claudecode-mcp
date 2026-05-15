// Tests for invokeCli's timeout and output-cap enforcement (C1, C2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync } from "node:fs";
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

const TMP = mkdtempSync(join(tmpdir(), "claudecode-mcp-timeout-"));
process.env.CLAUDECODE_MCP_FAKE_OUTFILE = join(TMP, "argv.json");

const { invokeCli, InvokeTimeoutError, OutputTooLargeError } = await import("../dist/invoke.js");

test(
  "invokeCli kills a hung subprocess and rejects with InvokeTimeoutError",
  async () => {
    process.env.CLAUDECODE_MCP_FAKE_MODE = "hang";
    try {
      await assert.rejects(
        () =>
          invokeCli(STUB, ["--print"], {
            timeoutMs: 250,
          }),
        (err) => err instanceof InvokeTimeoutError && err.timeoutMs === 250,
      );
    } finally {
      delete process.env.CLAUDECODE_MCP_FAKE_MODE;
    }
  },
  { timeout: 10000 },
);

test(
  "invokeCli enforces maxOutputBytes and rejects with OutputTooLargeError",
  async () => {
    process.env.CLAUDECODE_MCP_FAKE_MODE = "huge_output";
    try {
      await assert.rejects(
        () =>
          invokeCli(STUB, ["--print"], {
            maxOutputBytes: 1024 * 1024, // 1MB cap; stub spews ~120MB
          }),
        (err) => err instanceof OutputTooLargeError && err.limitBytes === 1024 * 1024,
      );
    } finally {
      delete process.env.CLAUDECODE_MCP_FAKE_MODE;
    }
  },
  { timeout: 30000 },
);

test(
  "invokeCli env allowlist drops dangerous vars by default",
  async () => {
    // Stub will be invoked with --help; we don't care about output, just check
    // the env-printing path. Use a different stub that just prints env.
    // For simplicity, we set a dangerous var in this process and run the
    // normal stub: the stub's env is sanitized but the stub doesn't expose
    // it. Use a small inline node script instead.
    process.env.CLAUDE_CODE_SHELL_PREFIX = "should-not-leak";
    process.env.ANTHROPIC_API_KEY = "should-leak";
    try {
      const result = await invokeCli(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        { timeoutMs: 5000 },
      );
      const env = JSON.parse(result.stdout);
      assert.equal(env.CLAUDE_CODE_SHELL_PREFIX, undefined, "dangerous var must be stripped");
      assert.equal(env.ANTHROPIC_API_KEY, "should-leak", "auth var must be forwarded");
      assert.equal(env.NO_COLOR, "1");
      assert.equal(env.TERM, "dumb");
    } finally {
      delete process.env.CLAUDE_CODE_SHELL_PREFIX;
      delete process.env.ANTHROPIC_API_KEY;
    }
  },
  { timeout: 10000 },
);

test(
  "invokeCli env allowlist honors CLAUDECODE_MCP_EXTRA_ENV escape hatch",
  async () => {
    process.env.MY_CUSTOM_VAR = "custom-value";
    process.env.CLAUDECODE_MCP_EXTRA_ENV = "MY_CUSTOM_VAR";
    try {
      const result = await invokeCli(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        { timeoutMs: 5000 },
      );
      const env = JSON.parse(result.stdout);
      assert.equal(env.MY_CUSTOM_VAR, "custom-value");
    } finally {
      delete process.env.MY_CUSTOM_VAR;
      delete process.env.CLAUDECODE_MCP_EXTRA_ENV;
    }
  },
  { timeout: 10000 },
);

// TEST-003: FORWARD_DANGEROUS=1 re-enables dangerous vars (when also in EXTRA_ENV)
test(
  "invokeCli env allowlist forwards dangerous vars when CLAUDECODE_MCP_FORWARD_DANGEROUS=1",
  async () => {
    process.env.CLAUDE_CODE_SHELL_PREFIX = "should-now-leak";
    process.env.CLAUDECODE_MCP_FORWARD_DANGEROUS = "1";
    // FORWARD_DANGEROUS bypasses the DANGEROUS_VARS drop, but the var must
    // still pass the normal allowlist. Add it to EXTRA_ENV.
    process.env.CLAUDECODE_MCP_EXTRA_ENV = "CLAUDE_CODE_SHELL_PREFIX";
    try {
      const result = await invokeCli(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        { timeoutMs: 5000 },
      );
      const env = JSON.parse(result.stdout);
      assert.equal(
        env.CLAUDE_CODE_SHELL_PREFIX,
        "should-now-leak",
        "dangerous var must be forwarded when FORWARD_DANGEROUS=1 and in EXTRA_ENV",
      );
    } finally {
      delete process.env.CLAUDE_CODE_SHELL_PREFIX;
      delete process.env.CLAUDECODE_MCP_FORWARD_DANGEROUS;
      delete process.env.CLAUDECODE_MCP_EXTRA_ENV;
    }
  },
  { timeout: 10000 },
);

// TEST-012: invokeCli stdin forwarding
test(
  "invokeCli forwards stdin to the child process",
  async () => {
    const stdinPayload = "hello from stdin";
    const result = await invokeCli(
      process.execPath,
      [
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))",
      ],
      { stdin: stdinPayload, timeoutMs: 5000 },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, stdinPayload);
  },
  { timeout: 10000 },
);

// TEST-004: SIGKILL escalation after SIGTERM grace period (CORR-001)
test(
  "invokeCli escalates to SIGKILL when child ignores SIGTERM",
  async () => {
    process.env.CLAUDECODE_MCP_FAKE_MODE = "ignore_sigterm";
    try {
      // Use a very short timeout so SIGTERM fires quickly, then the 2s grace
      // period should escalate to SIGKILL.
      await assert.rejects(
        () => invokeCli(STUB, ["--print"], { timeoutMs: 200 }),
        (err) => err instanceof InvokeTimeoutError,
      );
    } finally {
      delete process.env.CLAUDECODE_MCP_FAKE_MODE;
    }
  },
  { timeout: 15000 },
);
