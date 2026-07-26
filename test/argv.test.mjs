// Verifies argv construction for invokeCli / runClaudePrompt:
//   - shell:false (no shell interpolation, even for prompts containing
//     metacharacters like `$(...)` and backticks)
//   - correct flag ordering from baseClaudeArgs()
//   - --no-session-persistence is always present
//   - --strict-mcp-config + empty --mcp-config is always present (non-bare)
//   - --bare is set when CLAUDECODE_MCP_BARE=1
//   - prompt is passed as the LAST positional arg, preceded by a `--`
//     end-of-options separator (M1: dash-leading prompts can never be
//     parsed as CLI flags)
//   - --model and --append-system-prompt are forwarded when provided
//   - H1: prompts above MAX_PROMPT_ARG_BYTES are delivered via stdin (never
//     as a single argv element, which would exceed Linux's 128 KiB
//     MAX_ARG_STRLEN and fail the spawn with E2BIG)

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

const {
  runClaudePrompt,
  runClaudePromptStructured,
  baseClaudeArgs,
  routePromptDelivery,
  MAX_PROMPT_ARG_BYTES,
} = await import("../dist/server.js");
const { assertArgvWithinPlatformLimit, WINDOWS_COMMAND_LINE_MAX_UNITS } =
  await import("../dist/invoke.js");

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

test("runClaudePrompt argv: base flags + prompt as last positional after --", async () => {
  delete process.env.CLAUDECODE_MCP_BARE;
  await runClaudePrompt({ prompt: "hello world" });
  const argv = readArgv();
  assert.deepEqual(argv.slice(0, DEFAULT_BASE_ARGS.length), DEFAULT_BASE_ARGS);
  assert.equal(argv[argv.length - 1], "hello world");
  assert.equal(argv[argv.length - 2], "--", "prompt must be preceded by -- (end of options)");
  assert.ok(argv.includes("--no-session-persistence"));
  assert.ok(argv.includes("--strict-mcp-config"));
});

test("M1: dash-leading prompt is delivered after -- and cannot be parsed as a flag", async () => {
  delete process.env.CLAUDECODE_MCP_BARE;
  // Without the -- separator, this prompt would be consumed by the CLI's
  // option parser as the --continue flag (resuming a prior session and
  // silently defeating the no-session-persistence guarantee).
  await runClaudePrompt({ prompt: "--continue" });
  const argv = readArgv();
  assert.equal(argv[argv.length - 1], "--continue");
  assert.equal(argv[argv.length - 2], "--", "-- must precede the dash-leading prompt");
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

// ── H1: large prompts must travel via stdin, not argv ────────────────
// Linux caps a single argv element at MAX_ARG_STRLEN (128 KiB). Before the
// fix, any prompt larger than that rejected at spawn with a raw `E2BIG`,
// making the documented 5 MB file-context capacity unusable.

const STDIN_OUTFILE = join(TMP, "stdin.txt");

test("routePromptDelivery: small prompt is appended to argv after --, no stdin payload", () => {
  const args = ["--print"];
  const stdinPayload = routePromptDelivery(args, "hello");
  assert.equal(stdinPayload, undefined);
  assert.deepEqual(args, ["--print", "--", "hello"]);
});

test("routePromptDelivery: prompt exactly at MAX_PROMPT_ARG_BYTES stays on argv", () => {
  const at = "z".repeat(MAX_PROMPT_ARG_BYTES);
  const args = [];
  assert.equal(routePromptDelivery(args, at), undefined);
  assert.deepEqual(args, ["--", at]);
});

test("routePromptDelivery: >MAX_PROMPT_ARG_BYTES prompt is routed to stdin, argv untouched", () => {
  const big = "y".repeat(MAX_PROMPT_ARG_BYTES + 1);
  const args = ["--print"];
  assert.equal(routePromptDelivery(args, big), big);
  assert.deepEqual(args, ["--print"], "large prompt must not be appended to argv");
});

test("routePromptDelivery: threshold is measured in UTF-8 bytes, not characters", () => {
  // "é" is 2 bytes in UTF-8, so this string is under the threshold in
  // characters but over it in bytes — it must be routed via stdin.
  const multiByte = "é".repeat(Math.floor(MAX_PROMPT_ARG_BYTES / 2) + 1);
  assert.ok(multiByte.length <= MAX_PROMPT_ARG_BYTES);
  const args = [];
  assert.equal(routePromptDelivery(args, multiByte), multiByte);
  assert.deepEqual(args, []);
});

test("MAX_PROMPT_ARG_BYTES leaves headroom under Linux MAX_ARG_STRLEN (128 KiB)", () => {
  assert.ok(MAX_PROMPT_ARG_BYTES < 128 * 1024);
});

test("Windows routing accounts for the complete command line, not only prompt bytes", () => {
  const systemPrompt = "s".repeat(20_000);
  const prompt = "p".repeat(20_000);
  const args = ["--append-system-prompt", systemPrompt];
  const before = [...args];
  assert.ok(Buffer.byteLength(prompt) < MAX_PROMPT_ARG_BYTES);
  assert.equal(routePromptDelivery(args, prompt, "win32", "claude"), prompt);
  assert.deepEqual(args, before, "prompt routed to stdin must not mutate argv");
});

test("Windows routing keeps a small complete command line on argv", () => {
  const args = ["--print"];
  assert.equal(routePromptDelivery(args, "small", "win32", "claude"), undefined);
  assert.deepEqual(args, ["--print", "--", "small"]);
});

test("oversized non-prompt Windows argv is rejected before spawn", () => {
  assert.throws(
    () =>
      assertArgvWithinPlatformLimit(
        "claude",
        ["--append-system-prompt", "s".repeat(WINDOWS_COMMAND_LINE_MAX_UNITS)],
        "win32",
      ),
    /Windows command-line limit/,
  );
});

test("H1: runClaudePrompt delivers a >128 KiB prompt via stdin (no E2BIG)", async () => {
  delete process.env.CLAUDECODE_MCP_BARE;
  process.env.CLAUDECODE_MCP_FAKE_STDIN_OUTFILE = STDIN_OUTFILE;
  try {
    // 200 KiB — over Linux's 128 KiB per-argv-element cap. As a single argv
    // element this spawn would reject with E2BIG before the fix.
    const bigPrompt = "x".repeat(200 * 1024);
    const out = await runClaudePrompt({ prompt: bigPrompt });
    assert.equal(out, "ok-response", "spawn must succeed — no E2BIG");
    const argv = readArgv();
    assert.deepEqual(argv, DEFAULT_BASE_ARGS, "argv must contain flags only, no positional prompt");
    const received = readFileSync(STDIN_OUTFILE, "utf8");
    assert.equal(received, bigPrompt, "child must receive the full prompt on stdin");
  } finally {
    delete process.env.CLAUDECODE_MCP_FAKE_STDIN_OUTFILE;
  }
});

test("H1: runClaudePromptStructured delivers a >128 KiB prompt via stdin (no E2BIG)", async () => {
  delete process.env.CLAUDECODE_MCP_BARE;
  process.env.CLAUDECODE_MCP_FAKE_STDIN_OUTFILE = STDIN_OUTFILE;
  try {
    const schema = { type: "object", required: ["name"] };
    const bigPrompt = "s".repeat(200 * 1024);
    const json = await runClaudePromptStructured({ prompt: bigPrompt, schema });
    assert.deepEqual(json, { name: "stub" });
    const argv = readArgv();
    const schemaIdx = argv.indexOf("--json-schema");
    assert.ok(schemaIdx >= 0, "argv must still include --json-schema");
    assert.equal(
      argv[argv.length - 1],
      JSON.stringify(schema),
      "schema value is the last argv element — no positional prompt",
    );
    assert.ok(!argv.includes(bigPrompt), "large prompt must not be on argv");
    const received = readFileSync(STDIN_OUTFILE, "utf8");
    assert.equal(received, bigPrompt, "child must receive the full prompt on stdin");
  } finally {
    delete process.env.CLAUDECODE_MCP_FAKE_STDIN_OUTFILE;
  }
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
