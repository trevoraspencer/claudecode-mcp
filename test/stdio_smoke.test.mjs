// Stdio MCP server smoke test (VAL-VALID-009).
// Spawns the built server as a child process and exercises the MCP JSON-RPC
// lifecycle over stdio: initialize → tools/list → tools/call.  Uses the fake
// Claude stub so no real CLI or API key is needed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "_fake_claude.mjs");
try {
  chmodSync(STUB, 0o755);
} catch {
  // best-effort
}

const SERVER = join(HERE, "..", "dist", "server.js");
const TMP = mkdtempSync(join(tmpdir(), "claudecode-mcp-stdio-"));

// ---------------------------------------------------------------------------
// Helpers: newline-delimited JSON-RPC over stdio (MCP SDK framing).
// ---------------------------------------------------------------------------

let seq = 0;
function makeRequest(method, params) {
  return { jsonrpc: "2.0", id: ++seq, method, params };
}

/**
 * Send a JSON-RPC message over the child's stdin and collect a single
 * response line from stdout.  Returns the parsed response object.
 */
function roundtrip(child, req, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`roundtrip timeout for ${req.method}`)),
      timeoutMs,
    );
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        const line = buf.slice(0, idx);
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(new Error(`non-JSON response: ${line.slice(0, 200)}`));
        }
      }
    };
    child.stdout.on("data", onData);
    child.stdin.write(JSON.stringify(req) + "\n");
  });
}

/**
 * Spawn the server with env pointing to the fake stub.
 */
function spawnServer() {
  const child = spawn(process.execPath, [SERVER], {
    cwd: TMP,
    env: {
      ...process.env,
      CLAUDECODE_MCP_CLAUDE_BIN: STUB,
      CLAUDECODE_MCP_FAKE_MODE: "ok",
      CLAUDECODE_MCP_FAKE_HAS_JSON_SCHEMA: "1",
      CLAUDECODE_MCP_FAKE_OUTFILE: join(TMP, "argv.json"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
}

// ---------------------------------------------------------------------------
// Package metadata checks (synchronous).
// ---------------------------------------------------------------------------

test("package bin maps claudecode-mcp to dist/server.js", () => {
  const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
  assert.equal(pkg.bin["claudecode-mcp"], "dist/server.js");
});

test("package files include dist, examples, README, LICENSE, CHANGELOG", () => {
  const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
  const files = pkg.files;
  assert.ok(files.includes("dist"));
  assert.ok(files.includes("examples"));
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("LICENSE"));
  assert.ok(files.includes("CHANGELOG.md"));
});

// ---------------------------------------------------------------------------
// Stdio MCP lifecycle.
// ---------------------------------------------------------------------------

let child;
after(() => {
  if (child && !child.killed) {
    child.kill();
  }
});

test("stdio: initialize + tools/list returns three tools", async () => {
  child = spawnServer();

  // 1. initialize
  const initResp = await roundtrip(
    child,
    makeRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.0" },
    }),
  );
  assert.equal(initResp.jsonrpc, "2.0");
  assert.ok(initResp.result, "initialize should return a result");
  assert.equal(initResp.result.serverInfo.name, "claudecode-mcp");

  // Send initialized notification (no id = notification)
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 2. tools/list
  const toolsResp = await roundtrip(child, makeRequest("tools/list", {}));
  assert.equal(toolsResp.jsonrpc, "2.0");
  const names = toolsResp.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "claude_prompt",
    "claude_prompt_structured",
    "claude_prompt_with_context",
  ]);
});

test("stdio: tools/call claude_prompt returns text via stub", async () => {
  // The previous test already initialized; spawn a fresh server for this test
  // since the lifecycle is initialize → call in one session.
  if (child && !child.killed) child.kill();
  child = spawnServer();

  // initialize first
  await roundtrip(
    child,
    makeRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.0" },
    }),
  );
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // tools/call claude_prompt
  const callResp = await roundtrip(
    child,
    makeRequest("tools/call", {
      name: "claude_prompt",
      arguments: { prompt: "hello from smoke test" },
    }),
  );
  assert.equal(callResp.jsonrpc, "2.0");
  assert.ok(callResp.result, "tools/call should return a result");
  assert.equal(callResp.result.content[0].type, "text");
  assert.equal(callResp.result.content[0].text, "ok-response");
  assert.equal(callResp.result.isError, undefined);
});
