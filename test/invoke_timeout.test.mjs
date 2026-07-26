// Tests for invokeCli's timeout and output-cap enforcement (C1, C2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, existsSync, readFileSync } from "node:fs";
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

const { invokeCli, InvokeTimeoutError, OutputTooLargeError, InvokeAbortedError } =
  await import("../dist/invoke.js");

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
    process.env.claude_code_extra_body = "case-variant-must-not-leak";
    process.env.ANTHROPIC_API_KEY = "should-leak";
    try {
      const result = await invokeCli(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        { timeoutMs: 5000 },
      );
      const env = JSON.parse(result.stdout);
      assert.equal(env.CLAUDE_CODE_SHELL_PREFIX, undefined, "dangerous var must be stripped");
      assert.equal(
        env.claude_code_extra_body,
        undefined,
        "case variants of dangerous vars must be stripped",
      );
      assert.equal(env.ANTHROPIC_API_KEY, "should-leak", "auth var must be forwarded");
      assert.equal(env.NO_COLOR, "1");
      assert.equal(env.TERM, "dumb");
    } finally {
      delete process.env.CLAUDE_CODE_SHELL_PREFIX;
      delete process.env.claude_code_extra_body;
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

// TEST-003: FORWARD_DANGEROUS=1 is the explicit opt-in for dangerous vars.
test(
  "invokeCli env allowlist forwards dangerous vars when CLAUDECODE_MCP_FORWARD_DANGEROUS=1",
  async () => {
    process.env.CLAUDE_CODE_SHELL_PREFIX = "should-now-leak";
    process.env.CLAUDECODE_MCP_FORWARD_DANGEROUS = "1";
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
        "dangerous var must be forwarded when FORWARD_DANGEROUS=1",
      );
    } finally {
      delete process.env.CLAUDE_CODE_SHELL_PREFIX;
      delete process.env.CLAUDECODE_MCP_FORWARD_DANGEROUS;
    }
  },
  { timeout: 10000 },
);

test(
  "invokeCli forwards documented cloud-provider routing and credentials",
  async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "example-secret-access-key";
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/gcp-credentials.json";
    process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = "example-resource";
    try {
      const result = await invokeCli(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        { timeoutMs: 5000 },
      );
      const env = JSON.parse(result.stdout);
      assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1");
      assert.equal(env.AWS_REGION, "us-east-1");
      assert.equal(env.AWS_ACCESS_KEY_ID, "AKIAIOSFODNN7EXAMPLE");
      assert.equal(env.AWS_SECRET_ACCESS_KEY, "example-secret-access-key");
      assert.equal(env.CLAUDE_CODE_USE_VERTEX, "1");
      assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, "/tmp/gcp-credentials.json");
      assert.equal(env.CLAUDE_CODE_USE_FOUNDRY, "1");
      assert.equal(env.ANTHROPIC_FOUNDRY_RESOURCE, "example-resource");
    } finally {
      delete process.env.CLAUDE_CODE_USE_BEDROCK;
      delete process.env.AWS_REGION;
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.CLAUDE_CODE_USE_VERTEX;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      delete process.env.CLAUDE_CODE_USE_FOUNDRY;
      delete process.env.ANTHROPIC_FOUNDRY_RESOURCE;
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

test("invokeCli rejects before spawning when its signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => invokeCli("this-command-must-not-be-spawned", [], { signal: controller.signal }),
    (err) => err instanceof InvokeAbortedError && err.code === "ABORT_ERR",
  );
});

test(
  "invokeCli cancels an active subprocess through AbortSignal",
  async () => {
    const controller = new AbortController();
    const pending = invokeCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(
      () => pending,
      (err) => err instanceof InvokeAbortedError && /cancelled/.test(err.message),
    );
  },
  { timeout: 10000 },
);

test(
  "invokeCli timeout kills descendants in the spawned POSIX process group",
  { skip: process.platform === "win32", timeout: 15000 },
  async () => {
    const pidFile = join(TMP, `descendant-${Date.now()}.pid`);
    const parentProgram = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e',",
      "\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' });",
      "writeFileSync(process.argv[1], String(child.pid));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");

    let descendantPid;
    try {
      await assert.rejects(
        () =>
          invokeCli(process.execPath, ["-e", parentProgram, pidFile], {
            timeoutMs: 300,
          }),
        (err) => err instanceof InvokeTimeoutError,
      );
      assert.ok(existsSync(pidFile), "parent should record the descendant PID");
      descendantPid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);

      const isRunning = () => {
        try {
          const stat = readFileSync(`/proc/${descendantPid}/stat`, "utf8");
          const state = stat.slice(stat.lastIndexOf(")") + 2).charAt(0);
          return state !== "Z";
        } catch {
          return false;
        }
      };
      assert.equal(isRunning(), false, "descendant must not survive timeout cleanup");
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  },
);
