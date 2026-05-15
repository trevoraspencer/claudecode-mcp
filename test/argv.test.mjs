// Verifies argv construction for invokeCli / runClaudePrompt:
//   - shell:false (no shell interpolation, even for prompts containing
//     metacharacters like `$(...)` and backticks)
//   - correct flag ordering from baseClaudeArgs()
//   - --no-session-persistence is always present
//   - --strict-mcp-config + empty --mcp-config is always present (non-bare)
//   - --bare is set when CLAUDECODE_MCP_BARE=1
//   - prompt is passed as the LAST positional arg
//   - --model and --append-system-prompt are forwarded when provided

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "_fake_claude.mjs");

// Make sure the stub is executable in case it was copied without the bit
// (e.g. on a filesystem extracted from a tarball).
try {
  chmodSync(STUB, 0o755);
} catch {
  // best-effort
}

const TMP = mkdtempSync(join(tmpdir(), "claudecode-mcp-argv-"));
const OUTFILE = join(TMP, "argv.json");

process.env.CLAUDECODE_MCP_CLAUDE_BIN = STUB;
process.env.CLAUDECODE_MCP_FAKE_OUTFILE = OUTFILE;
process.env.CLAUDECODE_MCP_FAKE_HAS_JSON_SCHEMA = "1";
process.env.CLAUDECODE_MCP_FAKE_MODE = "ok";

const { runClaudePrompt, runClaudePromptStructured, baseClaudeArgs } =
  await import("../dist/server.js");

function readArgv() {
  return JSON.parse(readFileSync(OUTFILE, "utf8"));
}

const DEFAULT_BASE_ARGS = [
  "--print",
  "--permission-mode",
  "bypassPermissions",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--output-format",
  "json",
];

test("baseClaudeArgs has the documented flag ordering (default mode)", () => {
  delete process.env.CLAUDECODE_MCP_BARE;
  const args = baseClaudeArgs();
  assert.deepEqual(args, DEFAULT_BASE_ARGS);
});

test("baseClaudeArgs in bare mode uses --bare and omits --strict-mcp-config", () => {
  process.env.CLAUDECODE_MCP_BARE = "1";
  try {
    const args = baseClaudeArgs();
    assert.deepEqual(args, [
      "--bare",
      "--print",
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
      "--output-format",
      "json",
    ]);
  } finally {
    delete process.env.CLAUDECODE_MCP_BARE;
  }
});

test("baseClaudeArgs always contains --no-session-persistence and --strict-mcp-config (default)", () => {
  delete process.env.CLAUDECODE_MCP_BARE;
  for (let i = 0; i < 5; i++) {
    const args = baseClaudeArgs();
    assert.ok(args.includes("--no-session-persistence"));
    assert.ok(args.includes("--strict-mcp-config"));
    const mcpIdx = args.indexOf("--mcp-config");
    assert.ok(mcpIdx >= 0);
    assert.equal(args[mcpIdx + 1], '{"mcpServers":{}}');
  }
});

test("runClaudePrompt argv: base flags + prompt as last positional", async () => {
  delete process.env.CLAUDECODE_MCP_BARE;
  await runClaudePrompt({ prompt: "hello world" });
  const argv = readArgv();
  assert.deepEqual(argv.slice(0, DEFAULT_BASE_ARGS.length), DEFAULT_BASE_ARGS);
  assert.equal(argv[argv.length - 1], "hello world");
  assert.ok(argv.includes("--no-session-persistence"));
  assert.ok(argv.includes("--strict-mcp-config"));
});

test("runClaudePrompt argv: forwards --model and --append-system-prompt", async () => {
  await runClaudePrompt({
    prompt: "p",
    model: "haiku",
    system_prompt: "be terse",
  });
  const argv = readArgv();
  const modelIdx = argv.indexOf("--model");
  assert.ok(modelIdx >= 0, "argv must include --model");
  assert.equal(argv[modelIdx + 1], "haiku");
  const sysIdx = argv.indexOf("--append-system-prompt");
  assert.ok(sysIdx >= 0, "argv must include --append-system-prompt");
  assert.equal(argv[sysIdx + 1], "be terse");
  assert.equal(argv[argv.length - 1], "p");
});

test("runClaudePromptStructured argv: includes --json-schema with serialized schema", async () => {
  const schema = { type: "object", required: ["name"] };
  await runClaudePromptStructured({ prompt: "q", schema });
  const argv = readArgv();
  const schemaIdx = argv.indexOf("--json-schema");
  assert.ok(schemaIdx >= 0, "argv must include --json-schema");
  // The schema is serialized as a JSON string and passed as a SINGLE argv
  // element — never shell-expanded.
  assert.deepEqual(JSON.parse(argv[schemaIdx + 1]), schema);
  assert.equal(argv[argv.length - 1], "q");
  // Base invariants still hold.
  assert.ok(argv.includes("--no-session-persistence"));
  assert.ok(argv.includes("--print"));
});

test("no shell interpolation: prompt with $(...) and backticks is passed verbatim", async () => {
  // If the spawn used shell:true, this prompt would execute `id` etc. We rely
  // on shell:false in invokeCli — the prompt should arrive at the stub argv
  // exactly as written, character-for-character.
  const evil = "$(echo PWNED) `id` && echo nope; rm -rf / # not really";
  await runClaudePrompt({ prompt: evil });
  const argv = readArgv();
  assert.equal(argv[argv.length - 1], evil);
  // No shell would ever produce a literal "$(echo PWNED)" substring after
  // expansion — its presence proves no shell ran.
  assert.ok(argv[argv.length - 1].includes("$(echo PWNED)"));
});
