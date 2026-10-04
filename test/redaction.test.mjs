import { test } from "node:test";
import assert from "node:assert/strict";

import { ERROR_SNIPPET_MAX, redactSecrets, sanitizeForClient } from "../dist/redaction.js";

test("pattern secrets are redacted", () => {
  const out = redactSecrets(
    "key sk-ant-abc123_XYZ and authorization: bearer abc.DEF_ghi~jkl+mnop/qrst== AKIAABCDEFGHIJKLMNOP",
  );
  assert.match(out, /sk-ant-\*\*\*/);
  assert.match(out, /Bearer \*\*\*/i);
  assert.doesNotMatch(out, /abc123|qrst|AKIAABCDEFGHIJKLMNOP/);
});

test("auth env values and EXTRA_ENV values are redacted", () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-value-1";
  process.env.CLAUDECODE_MCP_EXTRA_ENV = "MY_PRIVATE_HEADER";
  process.env.MY_PRIVATE_HEADER = "custom-extra-secret";
  try {
    const out = redactSecrets("a oauth-value-1 b custom-extra-secret c");
    assert.equal(out, "a *** b *** c");
  } finally {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDECODE_MCP_EXTRA_ENV;
    delete process.env.MY_PRIVATE_HEADER;
  }
});

test("caller-supplied secrets (profile env) are redacted", () => {
  assert.equal(redactSecrets("token=prof-secret", ["prof-secret"]), "token=***");
  assert.equal(sanitizeForClient("x prof-secret y", 0, ["prof-secret"]), "x *** y");
});

test("sanitizeForClient caps output", () => {
  const out = sanitizeForClient("a".repeat(ERROR_SNIPPET_MAX * 3));
  assert.equal(out.length, ERROR_SNIPPET_MAX + "...[truncated]".length);
  assert.ok(out.endsWith("...[truncated]"));
});

test("sanitizeForClient removes a secret that crosses the window edge", () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "edge-secret-value";
  try {
    const text = "x".repeat(ERROR_SNIPPET_MAX - 4) + "edge-secret-value" + "y".repeat(2000);
    const out = sanitizeForClient(text);
    assert.doesNotMatch(out, /edge-sec/);
  } finally {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("sanitizeForClient redacts a secret the offset lands inside", () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "inside-secret";
  try {
    const out = sanitizeForClient("inside-secret tail", 3);
    assert.equal(out, "*** tail");
  } finally {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("GitHub tokens are redacted by value and by shape", () => {
  process.env.GH_TOKEN = "server-push-token-value";
  try {
    const out = redactSecrets(
      "a server-push-token-value b ghp_" +
        "A".repeat(36) +
        " c github_pat_11ABCDEFG0123456789_abcdefghijklmnop d",
    );
    assert.equal(out, "a *** b gh*_*** c github_pat_*** d");
  } finally {
    delete process.env.GH_TOKEN;
  }
});
