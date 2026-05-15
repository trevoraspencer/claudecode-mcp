// Error-path coverage for the runClaude* functions:
//   - missing CLI binary (spawn ENOENT)
//   - non-zero CLI exit
//   - malformed JSON returned from --json-schema invocation
//   - schema-validation miss for claude_prompt_structured (well-formed JSON
//     but the structured_output payload doesn't match the requested schema)
//   - claude_prompt_structured with no schema arg fails loudly

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

const TMP = mkdtempSync(join(tmpdir(), "claudecode-mcp-err-"));

process.env.CLAUDECODE_MCP_CLAUDE_BIN = STUB;
process.env.CLAUDECODE_MCP_FAKE_OUTFILE = join(TMP, "argv.json");
process.env.CLAUDECODE_MCP_FAKE_HAS_JSON_SCHEMA = "1";

const { runClaudePrompt, runClaudePromptStructured } = await import("../dist/server.js");

// Prime the --json-schema flag cache against the stub (not the bogus path
// used in the missing-binary test below).
test("setup: prime --json-schema cache via stub --help", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";
  await runClaudePromptStructured({
    prompt: "warm cache",
    schema: { type: "object", required: ["name"] },
  });
});

test("non-zero CLI exit surfaces the exit code", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "exit_nonzero";
  try {
    await assert.rejects(() => runClaudePrompt({ prompt: "x" }), /claude CLI exited 1/);
  } finally {
    delete process.env.CLAUDECODE_MCP_FAKE_MODE;
  }
});

test("malformed JSON from --json-schema rejects with a parse error", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "malformed_json";
  try {
    await assert.rejects(
      () =>
        runClaudePromptStructured({
          prompt: "x",
          schema: { type: "object", required: ["name"] },
        }),
      /failed to parse JSON/,
    );
  } finally {
    delete process.env.CLAUDECODE_MCP_FAKE_MODE;
  }
});

test("structured_output present but missing required field rejects", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "wrong_structured";
  try {
    await assert.rejects(
      () =>
        runClaudePromptStructured({
          prompt: "x",
          // wrong_structured emits {wrong_field: "data"} — missing `name`.
          schema: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        }),
      /schema validation: missing required field 'name'/,
    );
  } finally {
    delete process.env.CLAUDECODE_MCP_FAKE_MODE;
  }
});

test("structured_output absent rejects with no-structured-output error", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "missing_structured";
  try {
    await assert.rejects(
      () =>
        runClaudePromptStructured({
          prompt: "x",
          schema: { type: "object", required: ["name"] },
        }),
      /no structured_output field/,
    );
  } finally {
    delete process.env.CLAUDECODE_MCP_FAKE_MODE;
  }
});

test("claude_prompt_structured without schema fails loudly", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";
  try {
    await assert.rejects(() => runClaudePromptStructured({ prompt: "x" }), /requires a `schema`/);
  } finally {
    delete process.env.CLAUDECODE_MCP_FAKE_MODE;
  }
});

// TEST-009: "missing CLI binary" test restores CLAUDECODE_MCP_CLAUDE_BIN in
// a finally block so that subsequent tests within this file are not poisoned.
test("missing CLI binary surfaces a spawn error", async () => {
  const origBin = process.env.CLAUDECODE_MCP_CLAUDE_BIN;
  process.env.CLAUDECODE_MCP_CLAUDE_BIN = "/definitely/does/not/exist/claude-binary-xyz";
  process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";
  try {
    await assert.rejects(
      () => runClaudePrompt({ prompt: "x" }),
      (err) => {
        // node spawn ENOENT — exact wording varies, but the path or ENOENT
        // should appear.
        const msg = err && err.message ? err.message : String(err);
        return /ENOENT|spawn|not found|no such file/i.test(msg);
      },
    );
  } finally {
    process.env.CLAUDECODE_MCP_CLAUDE_BIN = origBin;
    delete process.env.CLAUDECODE_MCP_FAKE_MODE;
  }
});
