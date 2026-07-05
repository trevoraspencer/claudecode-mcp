#!/usr/bin/env node
// Test stub for the `claude` CLI. Behavior is controlled via env vars so a
// single binary can simulate a variety of CLI responses.
//
// Env vars:
//   CLAUDECODE_MCP_FAKE_OUTFILE         - if set, the stub writes its argv
//                                         (JSON array) to this file on each
//                                         non-`--help` invocation. Tests read
//                                         this back to assert on argv shape.
//   CLAUDECODE_MCP_FAKE_STDIN_OUTFILE   - if set, the stub drains stdin to EOF
//                                         and writes the received bytes to this
//                                         file before dispatching on FAKE_MODE.
//                                         Tests read this back to assert that
//                                         large prompts arrive via stdin (H1).
//   CLAUDECODE_MCP_FAKE_HAS_JSON_SCHEMA - "1" => `--help` output advertises
//                                         `--json-schema`; anything else => not.
//   CLAUDECODE_MCP_FAKE_MODE            - one of:
//       "ok"                 (default) prints valid JSON with `result` and
//                            `structured_output: { name: "stub" }`
//       "exit_nonzero"       prints to stderr and exits 1
//       "malformed_json"     prints non-JSON garbage on stdout, exits 0
//       "missing_structured" prints {"result":"..."} with no structured_output;
//                            the result text is CLAUDECODE_MCP_FAKE_RESULT_TEXT
//                            when set (used to test redact-before-truncate, L2)
//       "wrong_structured"   prints structured_output with the wrong shape
//       "hang"               sleeps forever — used to exercise timeout
//       "huge_output"        spews ~120MB of stdout — used to exercise the
//                            output cap
//       "leak_secret"        prints a fake sk-ant- token on stderr and exits 1
//                            — used to verify error-message redaction
//       "response_only"      prints {"response":"fallback-response"} with no
//                            `result` field — used to exercise the response
//                            field fallback in runClaudePrompt
//       "unexpected_shape"   prints {"cost_usd":0.01} with neither `result`
//                            nor `response` — used to test CORR-003 observability
//       "unexpected_array"   prints a JSON array — used to test CORR-003
//                            observability for non-object payloads

import { writeFileSync, writeSync } from "node:fs";

const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  const adv = process.env.CLAUDECODE_MCP_FAKE_HAS_JSON_SCHEMA === "1";
  let help = "Usage: claude [options] [prompt]\n";
  help += "  --print\n  --permission-mode <mode>\n  --no-session-persistence\n";
  help += "  --output-format <fmt>\n  --model <model>\n  --append-system-prompt <txt>\n";
  if (adv) help += "  --json-schema <schema>\n";
  process.stdout.write(help);
  process.exit(0);
}

const outfile = process.env.CLAUDECODE_MCP_FAKE_OUTFILE;
if (outfile) {
  try {
    writeFileSync(outfile, JSON.stringify(argv));
  } catch {
    // best-effort
  }
}

// H1: When requested, drain stdin to EOF and persist it so tests can assert
// that prompts above the argv size threshold are delivered via stdin rather
// than as a single argv element (which would E2BIG on Linux).
const stdinOutfile = process.env.CLAUDECODE_MCP_FAKE_STDIN_OUTFILE;
if (stdinOutfile) {
  let stdinData = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    stdinData += chunk;
  }
  try {
    writeFileSync(stdinOutfile, stdinData);
  } catch {
    // best-effort
  }
}

const mode = process.env.CLAUDECODE_MCP_FAKE_MODE ?? "ok";

switch (mode) {
  case "exit_nonzero":
    process.stderr.write("simulated stub failure\n");
    process.exit(1);
  case "malformed_json":
    process.stdout.write("zzz this is not json output\nneither is this\n");
    process.exit(0);
  case "missing_structured":
    process.stdout.write(
      JSON.stringify({
        result: process.env.CLAUDECODE_MCP_FAKE_RESULT_TEXT ?? "summary text",
      }) + "\n",
    );
    process.exit(0);
  case "wrong_structured":
    process.stdout.write(
      JSON.stringify({
        result: "summary text",
        structured_output: { wrong_field: "data" },
      }) + "\n",
    );
    process.exit(0);
  case "hang":
    // Keep the event loop alive so the parent's timeout has work to do.
    setInterval(() => undefined, 1000);
    break;
  case "huge_output": {
    // Write synchronously to fd 1 so the parent sees bytes immediately. We
    // do NOT exit — the parent's output cap should SIGTERM us instead.
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    try {
      for (let i = 0; i < 200; i++) {
        writeSync(1, chunk);
      }
    } catch {
      // pipe closed by parent after cap-kill
    }
    setInterval(() => undefined, 1000);
    break;
  }
  case "leak_secret":
    process.stderr.write("auth failed: token sk-ant-FAKETOKEN1234567890 invalid\n");
    process.exit(1);
  case "ignore_sigterm":
    // Ignore SIGTERM so the parent must escalate to SIGKILL. Used to test
    // the SIGKILL escalation timer (TEST-004, CORR-001).
    process.on("SIGTERM", () => {
      /* ignore */
    });
    // Keep running so the parent has to SIGKILL us.
    setInterval(() => undefined, 1000);
    break;
  case "response_only":
    process.stdout.write(JSON.stringify({ response: "fallback-response" }) + "\n");
    process.exit(0);
  case "unexpected_shape":
    process.stdout.write(JSON.stringify({ cost_usd: 0.01, model: "claude-3" }) + "\n");
    process.exit(0);
  case "unexpected_array":
    process.stdout.write(JSON.stringify(["item1", "item2"]) + "\n");
    process.exit(0);
  case "ok":
  default:
    process.stdout.write(
      JSON.stringify({
        result: "ok-response",
        structured_output: { name: "stub" },
      }) + "\n",
    );
    process.exit(0);
}
