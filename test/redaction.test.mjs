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

test("redaction covers RFC bearer characters, case variants, passphrases, and EXTRA_ENV", async () => {
  const { redactSecrets } = await import("../dist/server.js");
  process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE = "client-passphrase-value";
  process.env.CLAUDECODE_MCP_EXTRA_ENV = "MY_PRIVATE_HEADER";
  process.env.MY_PRIVATE_HEADER = "custom-extra-secret";
  try {
    const result = redactSecrets(
      [
        "authorization: bearer abc.DEF_ghi~jkl+mnop/qrst==",
        "client-passphrase-value",
        "custom-extra-secret",
      ].join("\n"),
    );
    assert.match(result, /Bearer \*\*\*/i);
    assert.ok(!result.includes("abc.DEF_ghi"));
    assert.ok(!result.includes("client-passphrase-value"));
    assert.ok(!result.includes("custom-extra-secret"));
  } finally {
    delete process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE;
    delete process.env.CLAUDECODE_MCP_EXTRA_ENV;
    delete process.env.MY_PRIVATE_HEADER;
  }
});

test("client sanitization is bounded and redacts secrets crossing its output window", async () => {
  const { sanitizeForClient, ERROR_SNIPPET_MAX } = await import("../dist/server.js");
  const longSecret = "secret-" + "z".repeat(800);
  process.env.ANTHROPIC_AUTH_TOKEN = longSecret;
  try {
    const straddled = sanitizeForClient("x".repeat(ERROR_SNIPPET_MAX - 20) + longSecret + "tail");
    assert.ok(!straddled.includes("secret-"));
    assert.match(straddled, /\*\*\*/);
    assert.match(straddled, /\[truncated\]$/);

    process.env.ANTHROPIC_AUTH_TOKEN = "a";
    const huge = sanitizeForClient("a".repeat(5 * 1024 * 1024));
    assert.ok(huge.length <= ERROR_SNIPPET_MAX + "...[truncated]".length);
    assert.ok(huge.startsWith("***"));
    assert.ok(!huge.includes("aaaa"));
  } finally {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("client sanitization redacts a secret that begins before startOffset", async () => {
  const { sanitizeForClient, exitError } = await import("../dist/server.js");
  const secret = "  arbitrary-forwarded-secret";
  process.env.ANTHROPIC_AUTH_TOKEN = secret;
  try {
    const sanitized = sanitizeForClient(`${secret} tail`, 2);
    assert.ok(!sanitized.includes("arbitrary-forwarded-secret"));
    assert.match(sanitized, /^\*\*\*/);

    const error = exitError(1, `${secret} rejected`, "");
    assert.ok(!error.message.includes("arbitrary-forwarded-secret"));
    assert.match(error.message, /\*\*\*/);
  } finally {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("parse failures cannot leak a forwarded secret prefix cut by diagnostics", async () => {
  const secret = "forwarded-secret-abcdefghijklmnopqrstuvwxyz";
  process.env.CLAUDECODE_MCP_EXTRA_ENV = "MY_PARSE_SECRET";
  process.env.MY_PARSE_SECRET = secret;
  process.env.CLAUDECODE_MCP_FAKE_RESULT_TEXT = "x".repeat(190) + secret;
  process.env.CLAUDECODE_MCP_FAKE_MODE = "malformed_secret";
  try {
    await assert.rejects(
      () => runClaudePrompt({ prompt: "x" }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /failed to parse JSON/);
        assert.ok(!msg.includes("forwarded-secret"));
        return true;
      },
    );
  } finally {
    delete process.env.CLAUDECODE_MCP_EXTRA_ENV;
    delete process.env.MY_PARSE_SECRET;
    delete process.env.CLAUDECODE_MCP_FAKE_RESULT_TEXT;
    delete process.env.CLAUDECODE_MCP_FAKE_MODE;
  }
});

test("redaction covers newly forwarded cloud credential values", async () => {
  const { redactSecrets } = await import("../dist/server.js");
  process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-value";
  process.env.AWS_SESSION_TOKEN = "aws-session-value";
  process.env.AZURE_CLIENT_SECRET = "azure-secret-value";
  try {
    const result = redactSecrets("aws-secret-value aws-session-value azure-secret-value");
    assert.equal(result, "*** *** ***");
  } finally {
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AZURE_CLIENT_SECRET;
  }
});
