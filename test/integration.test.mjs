import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runClaudePrompt,
  runClaudePromptStructured,
  isJsonSchemaFlagAvailable,
  classifyClaudeExit,
  validateAgainstSchema,
} from "../dist/server.js";

const LIVE = process.env.CLAUDECODE_MCP_LIVE === "1";

// TEST-010: Non-skipped informational test that makes live-test skip
// visibility prominent in the test output. When CLAUDECODE_MCP_LIVE is not
// set, this test passes but prints a clear reminder so CI runs and developers
// see that live coverage was not exercised.
test(
  "live test skip visibility: " +
    (LIVE ? "LIVE mode active" : "CLAUDECODE_MCP_LIVE is not set — live tests are skipped"),
  () => {
    if (!LIVE) {
      // Use a diagnostic assertion message so the skip reason is visible in
      // the TAP output without making the test fail.
      assert.ok(
        true,
        "4 live-gated integration tests were skipped because CLAUDECODE_MCP_LIVE is not set. Run `npm run test:live` for full coverage.",
      );
    } else {
      assert.ok(true, "Live mode is active — live-gated tests will execute.");
    }
  },
);

test("classifyClaudeExit maps codes", () => {
  assert.equal(classifyClaudeExit(0), "ok");
  assert.equal(classifyClaudeExit(1), "error");
  assert.equal(classifyClaudeExit(2), "usage_error");
  assert.equal(classifyClaudeExit(7), "exit_7");
  assert.equal(classifyClaudeExit(null), "unknown");
});

test("validateAgainstSchema enforces required fields", () => {
  const schema = {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  };
  assert.throws(() => validateAgainstSchema({}, schema), /missing required/);
  assert.doesNotThrow(() => validateAgainstSchema({ name: "x" }, schema));
});

test("live: --json-schema flag is detected", { skip: !LIVE }, async () => {
  const ok = await isJsonSchemaFlagAvailable();
  assert.equal(ok, true);
});

test("live: claude_prompt returns text for tiny prompt", { skip: !LIVE }, async () => {
  const text = await runClaudePrompt({
    prompt: "Reply with the single word: ping",
    model: "haiku",
  });
  assert.ok(text.length > 0);
});

test("live: claude_prompt_structured returns schema-valid JSON", { skip: !LIVE }, async () => {
  const schema = {
    type: "object",
    required: ["word"],
    properties: { word: { type: "string" } },
  };
  const out = await runClaudePromptStructured({
    prompt: "Return JSON with a 'word' field equal to 'ping'",
    schema,
    model: "haiku",
  });
  assert.equal(typeof out, "object");
  assert.equal(typeof out.word, "string");
});

test("live: structured fails loudly without schema", { skip: !LIVE }, async () => {
  await assert.rejects(() => runClaudePromptStructured({ prompt: "x" }), /requires a `schema`/);
});
