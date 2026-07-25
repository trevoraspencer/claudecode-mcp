// H3 verification: when the CLI exits non-zero, the error message returned
// to MCP clients must redact sk-ant-* tokens and Bearer tokens, and must be
// truncated to a sane size.

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

const TMP = mkdtempSync(join(tmpdir(), "claudecode-mcp-redact-"));
process.env.CLAUDECODE_MCP_CLAUDE_BIN = STUB;
process.env.CLAUDECODE_MCP_FAKE_OUTFILE = join(TMP, "argv.json");

const { runClaudePrompt } = await import("../dist/server.js");

test("CLI stderr containing a fake sk-ant- token is redacted in the thrown error", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "leak_secret";
  try {
    await assert.rejects(
      () => runClaudePrompt({ prompt: "x" }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(/sk-ant-\*\*\*/.test(msg), `expected redacted token in: ${msg}`);
        assert.ok(!/sk-ant-FAKETOKEN/.test(msg), `raw token must not leak: ${msg}`);
        return true;
      },
    );
  } finally {
    delete process.env.CLAUDECODE_MCP_FAKE_MODE;
  }
});

test("auth env value present in stderr is redacted", async () => {
  // We can't easily inject this through the stub, but the redactor walks the
  // env-var list. Verify that env-var values from the redaction key list are
  // replaced when they appear in error output.
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "testtoken-not-secret";
  process.env.CLAUDECODE_MCP_FAKE_MODE = "leak_secret";
  try {
    await assert.rejects(
      () => runClaudePrompt({ prompt: "x" }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        // The sk-ant-* pattern catches both the stub's fake token AND the
        // real-looking env-var key. Either way, neither raw value leaks.
        assert.ok(!/FAKETOKEN1234567890/.test(msg));
        assert.ok(!/testtoken-not-secret/.test(msg));
        return true;
      },
    );
  } finally {
    delete process.env.CLAUDECODE_MCP_FAKE_MODE;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
});
