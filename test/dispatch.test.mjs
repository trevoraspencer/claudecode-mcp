// MCP dispatch tests: listTools() and handleCallTool() — the request
// handlers wired into the Server in main().

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

const TMP = mkdtempSync(join(tmpdir(), "claudecode-mcp-disp-"));
process.env.CLAUDECODE_MCP_CLAUDE_BIN = STUB;
process.env.CLAUDECODE_MCP_FAKE_OUTFILE = join(TMP, "argv.json");
process.env.CLAUDECODE_MCP_FAKE_HAS_JSON_SCHEMA = "1";
process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";

const { listTools, handleCallTool, resetFlagCache } = await import("../dist/server.js");

test("listTools returns all three tool definitions", () => {
  const result = listTools();
  const names = result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "claude_prompt",
    "claude_prompt_structured",
    "claude_prompt_with_context",
  ]);
});

test("listTools tool schemas are objects with required fields", () => {
  for (const tool of listTools().tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(Array.isArray(tool.inputSchema.required));
    assert.ok(tool.inputSchema.required.includes("prompt"));
  }
});

test("handleCallTool: claude_prompt returns text content from CLI", async () => {
  const res = await handleCallTool({
    params: { name: "claude_prompt", arguments: { prompt: "hi" } },
  });
  assert.equal(res.isError, undefined);
  assert.equal(res.content.length, 1);
  assert.equal(res.content[0].type, "text");
  assert.equal(res.content[0].text, "ok-response");
});

test("handleCallTool: claude_prompt_structured returns JSON-stringified payload", async () => {
  const res = await handleCallTool({
    params: {
      name: "claude_prompt_structured",
      arguments: {
        prompt: "p",
        schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      },
    },
  });
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(res.content[0].text), { name: "stub" });
});

test("handleCallTool: unknown tool yields isError with a clear message", async () => {
  const res = await handleCallTool({
    params: { name: "definitely_not_a_tool", arguments: {} },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /unknown tool: definitely_not_a_tool/);
});

test("handleCallTool: invalid arguments yield isError, never throw", async () => {
  const res = await handleCallTool({
    params: { name: "claude_prompt", arguments: { prompt: "" } },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /`prompt` must be a non-empty string/);
});

test(
  "handleCallTool propagates request cancellation to the active CLI process",
  async () => {
    process.env.CLAUDECODE_MCP_FAKE_MODE = "hang";
    const controller = new AbortController();
    try {
      const pending = handleCallTool(
        {
          params: { name: "claude_prompt", arguments: { prompt: "cancel me" } },
        },
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 100);
      const res = await pending;
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /cancelled/);
    } finally {
      process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";
    }
  },
  { timeout: 10000 },
);

test(
  "structured-call cancellation interrupts the shared --json-schema flag probe",
  async () => {
    resetFlagCache();
    process.env.CLAUDECODE_MCP_FAKE_HELP_DELAY_MS = "5000";
    const controller = new AbortController();
    const started = Date.now();
    try {
      const pending = handleCallTool(
        {
          params: {
            name: "claude_prompt_structured",
            arguments: { prompt: "cancel probe", schema: { type: "object" } },
          },
        },
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 100);
      const res = await pending;
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /cancelled/);
      assert.ok(Date.now() - started < 3000, "cancelled probe must not run to its 5s delay");
    } finally {
      delete process.env.CLAUDECODE_MCP_FAKE_HELP_DELAY_MS;
      resetFlagCache();
    }
  },
  { timeout: 10000 },
);

test(
  "cancelling one structured caller does not abort a shared probe still in use",
  async () => {
    resetFlagCache();
    process.env.CLAUDECODE_MCP_FAKE_HELP_DELAY_MS = "300";
    const cancelled = new AbortController();
    try {
      const first = handleCallTool(
        {
          params: {
            name: "claude_prompt_structured",
            arguments: { prompt: "first", schema: { type: "object" } },
          },
        },
        { signal: cancelled.signal },
      );
      const second = handleCallTool({
        params: {
          name: "claude_prompt_structured",
          arguments: { prompt: "second", schema: { type: "object" } },
        },
      });
      setTimeout(() => cancelled.abort(), 50);

      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.equal(firstResult.isError, true);
      assert.match(firstResult.content[0].text, /cancelled/);
      assert.equal(secondResult.isError, undefined);
      assert.deepEqual(JSON.parse(secondResult.content[0].text), { name: "stub" });
    } finally {
      delete process.env.CLAUDECODE_MCP_FAKE_HELP_DELAY_MS;
      resetFlagCache();
    }
  },
  { timeout: 10000 },
);

test("handleCallTool: null arguments yield isError", async () => {
  const res = await handleCallTool({
    params: { name: "claude_prompt", arguments: null },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /must be an object/);
});

test("handleCallTool: CLI exit_nonzero is surfaced as isError, not thrown", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "exit_nonzero";
  try {
    const res = await handleCallTool({
      params: { name: "claude_prompt", arguments: { prompt: "x" } },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /claude CLI exited 1/);
  } finally {
    process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";
  }
});

// TEST-001: claude_prompt_with_context dispatch through handleCallTool
test("handleCallTool: claude_prompt_with_context dispatches and returns text content", async () => {
  const res = await handleCallTool({
    params: {
      name: "claude_prompt_with_context",
      arguments: { prompt: "summarize" },
    },
  });
  assert.equal(res.isError, undefined);
  assert.equal(res.content.length, 1);
  assert.equal(res.content[0].type, "text");
  assert.equal(res.content[0].text, "ok-response");
});

// TEST-002: response field fallback in runClaudePrompt
test("handleCallTool: claude_prompt returns response field when result is absent", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "response_only";
  try {
    const res = await handleCallTool({
      params: {
        name: "claude_prompt",
        arguments: { prompt: "hi" },
      },
    });
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0].text, "fallback-response");
  } finally {
    process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";
  }
});

// TEST-006: validateAgainstSchema with array, integer, boolean, null types
import { validateAgainstSchema } from "../dist/server.js";

test("validateAgainstSchema validates array type and recurses into items", () => {
  // Array type with items schema
  validateAgainstSchema([1, 2, 3], { type: "array", items: { type: "number" } });
  // Wrong item type should throw
  assert.throws(
    () => validateAgainstSchema([1, "wrong"], { type: "array", items: { type: "number" } }),
    /expected type 'number'/,
  );
});

test("validateAgainstSchema validates integer type", () => {
  validateAgainstSchema(42, { type: "integer" });
  assert.throws(() => validateAgainstSchema(3.14, { type: "integer" }), /expected type 'integer'/);
  assert.throws(
    () => validateAgainstSchema("not-int", { type: "integer" }),
    /expected type 'integer'/,
  );
});

test("validateAgainstSchema validates boolean type", () => {
  validateAgainstSchema(true, { type: "boolean" });
  validateAgainstSchema(false, { type: "boolean" });
  assert.throws(
    () => validateAgainstSchema("true", { type: "boolean" }),
    /expected type 'boolean'/,
  );
});

test("validateAgainstSchema validates null type", () => {
  validateAgainstSchema(null, { type: "null" });
  assert.throws(() => validateAgainstSchema(0, { type: "null" }), /expected type 'null'/);
  assert.throws(() => validateAgainstSchema("", { type: "null" }), /expected type 'null'/);
});

test("validateAgainstSchema validates nested array items in object properties", () => {
  validateAgainstSchema(
    { tags: ["a", "b"] },
    {
      type: "object",
      required: ["tags"],
      properties: {
        tags: { type: "array", items: { type: "string" } },
      },
    },
  );
  assert.throws(
    () =>
      validateAgainstSchema(
        { tags: [1, 2] },
        {
          type: "object",
          required: ["tags"],
          properties: {
            tags: { type: "array", items: { type: "string" } },
          },
        },
      ),
    /expected type 'string'/,
  );
});

// TEST-007: Error message truncation at 1 KB (ERROR_SNIPPET_MAX)
// Direct unit test for sanitizeForClient boundary behavior.
const { sanitizeForClient, ERROR_SNIPPET_MAX } = await import("../dist/redaction.js");

test("sanitizeForClient truncates output exceeding ERROR_SNIPPET_MAX", () => {
  const longInput = "x".repeat(ERROR_SNIPPET_MAX + 500);
  const result = sanitizeForClient(longInput);
  assert.ok(
    result.length <= ERROR_SNIPPET_MAX + 20,
    `truncated output should be near ${ERROR_SNIPPET_MAX} chars, got ${result.length}`,
  );
  assert.ok(
    result.endsWith("...[truncated]"),
    `truncated output should end with truncation marker, got: ...${result.slice(-30)}`,
  );
});

test("sanitizeForClient preserves output within ERROR_SNIPPET_MAX", () => {
  const shortInput = "short error message";
  const result = sanitizeForClient(shortInput);
  assert.equal(result, shortInput);
  assert.ok(!result.includes("...[truncated]"), "short output should not be truncated");
});

test("sanitizeForClient truncates at exactly ERROR_SNIPPET_MAX boundary", () => {
  const exactInput = "y".repeat(ERROR_SNIPPET_MAX);
  const overInput = "y".repeat(ERROR_SNIPPET_MAX + 1);
  assert.equal(
    sanitizeForClient(exactInput),
    exactInput,
    "exact-size input should not be truncated",
  );
  assert.ok(
    sanitizeForClient(overInput).includes("...[truncated]"),
    "one-byte-over input should be truncated",
  );
});

test("handleCallTool error messages are truncated to ~1 KB", async () => {
  process.env.CLAUDECODE_MCP_FAKE_MODE = "exit_nonzero";
  try {
    const res = await handleCallTool({
      params: { name: "claude_prompt", arguments: { prompt: "x" } },
    });
    assert.equal(res.isError, true);
    assert.ok(
      res.content[0].text.length < ERROR_SNIPPET_MAX + 200,
      `error message should be truncated near ${ERROR_SNIPPET_MAX}: got ${res.content[0].text.length} chars`,
    );
  } finally {
    process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";
  }
});

// TEST-008: escapePathForFence with multi-line paths
import { escapePathForFence } from "../dist/server.js";

test("escapePathForFence replaces newlines and carriage returns with spaces", () => {
  assert.equal(escapePathForFence("normal/path.txt"), "normal/path.txt");
  assert.equal(escapePathForFence("path/with\nnewline"), "path/with newline");
  // \r\r is a run of two carriage returns — replaced by a single space
  assert.equal(escapePathForFence("path/with\r\rcarriage"), "path/with carriage");
  assert.equal(escapePathForFence("multi\nline\r\npath"), "multi line path");
});
