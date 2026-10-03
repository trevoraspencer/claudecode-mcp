#!/usr/bin/env node
// Fake `claude` CLI for offline tests.
//
// Env knobs:
//   CLAUDECODE_MCP_FAKE_VERSION          text printed for --version (default "2.1.288 (Claude Code)")
//   CLAUDECODE_MCP_FAKE_EXIT             exit code for --version (default 0)
//   CLAUDECODE_MCP_FAKE_ENV_OUT          write the received env as JSON to this path
//   CLAUDECODE_MCP_FAKE_ARGV_OUT         append each invocation's argv as a JSON line
//   CLAUDECODE_MCP_FAKE_PERMISSION_MODE  permissionMode to report in system/init
//
// Stream mode (`-p --input-format stream-json ...`) reads user messages from
// stdin. Each message runs one turn: system/init, assistant, result. The
// message text picks the behavior:
//   SLOW <ms>          finish after <ms>; messages that arrive meanwhile join the turn
//   HANG               never finish on its own
//   IGNORE_INTERRUPT   never finish and ignore control-request interrupts
//   BIG <n>            emit an assistant event with <n> characters
//   RATE               emit a rate_limit_event first
//   CRASH              write a secret to stderr and exit 3
//   SPAWN_CHILD <file> start a long-lived child process, write its pid to <file>, then hang
//   INHERIT <file>     start a long-lived child that inherits stdout/stderr, write its
//                      pid to <file>, then finish the turn
//   IGNORE_INTERRUPT SILENT  as IGNORE_INTERRUPT, and exit on SIGINT without a result
// anything else       finish at once with result "echo: <text>"
// A control_request interrupt ends the turn with error_during_execution and
// keeps the process. SIGINT ends the turn the same way, then exits.

import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);

if (process.env.CLAUDECODE_MCP_FAKE_ENV_OUT) {
  writeFileSync(process.env.CLAUDECODE_MCP_FAKE_ENV_OUT, JSON.stringify(process.env));
}

if (args[0] === "--version") {
  process.stdout.write((process.env.CLAUDECODE_MCP_FAKE_VERSION ?? "2.1.288 (Claude Code)") + "\n");
  process.exit(Number(process.env.CLAUDECODE_MCP_FAKE_EXIT ?? 0));
}

if (process.env.CLAUDECODE_MCP_FAKE_ARGV_OUT) {
  appendFileSync(process.env.CLAUDECODE_MCP_FAKE_ARGV_OUT, JSON.stringify(args) + "\n");
}

if (!args.includes("-p") || !args.includes("stream-json")) {
  process.stderr.write(`fake claude: unsupported args ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = flag("--session-id") ?? flag("--resume");
const permissionMode =
  process.env.CLAUDECODE_MCP_FAKE_PERMISSION_MODE ?? flag("--permission-mode") ?? "default";
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const assistant = (text) =>
  out({
    type: "assistant",
    session_id: sessionId,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

let turn = null;
let stdinEnded = false;

function startTurn(text) {
  out({ type: "system", subtype: "init", session_id: sessionId, permissionMode, model: "fake" });
  if (text.startsWith("CRASH")) {
    process.stderr.write("boom sk-ant-FAKESECRET123\n");
    process.exit(3);
  }
  if (text.startsWith("RATE")) {
    out({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.42 },
    });
  }
  if (text.startsWith("BIG ")) assistant("x".repeat(Number(text.split(" ")[1])));
  if (text.startsWith("SPAWN_CHILD ")) {
    const pidFile = text.split(" ")[1];
    const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    writeFileSync(pidFile, String(kid.pid));
  }
  if (text.startsWith("INHERIT ")) {
    const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    writeFileSync(text.split(" ")[1], String(kid.pid));
  }
  assistant("working");
  turn = { text, extra: [], ignoreInterrupt: text.startsWith("IGNORE_INTERRUPT"), timer: null };
  if (text.startsWith("SLOW ")) {
    turn.timer = setTimeout(() => finishTurn("success"), Number(text.split(" ")[1]));
  } else if (
    !text.startsWith("HANG") &&
    !turn.ignoreInterrupt &&
    !text.startsWith("SPAWN_CHILD ")
  ) {
    finishTurn("success");
  }
}

function finishTurn(subtype) {
  const t = turn;
  turn = null;
  clearTimeout(t.timer);
  const ok = subtype === "success";
  const text = "echo: " + t.text + (t.extra.length ? " | also: " + t.extra.join(" | ") : "");
  out({
    type: "result",
    subtype,
    is_error: !ok,
    ...(ok ? { result: text } : {}),
    session_id: sessionId,
    num_turns: 1,
    duration_ms: 5,
    total_cost_usd: 0.001,
    usage: { input_tokens: 1, output_tokens: 2 },
    permission_denials: [],
  });
  if (stdinEnded) process.exit(0);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
    out({
      type: "control_response",
      response: { subtype: "success", request_id: msg.request_id, response: {} },
    });
    if (turn && !turn.ignoreInterrupt) finishTurn("error_during_execution");
    return;
  }
  if (msg.type !== "user") return;
  const text = msg.message?.content;
  if (turn) turn.extra.push(text);
  else startTurn(text);
});
rl.on("close", () => {
  stdinEnded = true;
  if (!turn) process.exit(0);
});

process.on("SIGINT", () => {
  if (turn?.text.includes("SILENT")) process.exit(0);
  if (turn) {
    turn.ignoreInterrupt = false;
    finishTurn("error_during_execution");
  }
  process.exit(0);
});
