// Entry point and stdio smoke tests. Spawns the built CLI.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../dist/cli.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "dist", "cli.js");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function isolatedEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claudecode-mcp-cli-"));
  return {
    ...process.env,
    CLAUDECODE_MCP_CONFIG: join(dir, "config.json"),
    CLAUDECODE_MCP_STATE_DIR: join(dir, "state"),
    CLAUDECODE_MCP_DEPTH: "",
    ...extra,
  };
}

function run(args, env = isolatedEnv()) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 10_000 });
}

test("package metadata points at the CLI and requires Node 22", () => {
  assert.equal(PKG.bin["claudecode-mcp"], "dist/cli.js");
  assert.equal(PKG.engines.node, ">=22");
  assert.deepEqual(PKG.os, ["darwin", "linux"]);
  assert.ok(statSync(CLI).mode & 0o100, "dist/cli.js must be executable");
});

test("--version prints the package version", () => {
  const r = run(["--version"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), PKG.version);
});

test("--help prints usage", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: claudecode-mcp/);
});

test("unknown commands exit 2", () => {
  const r = run(["bogus"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command: bogus/);
});

test("runner needs exactly one valid task id", () => {
  assert.equal(run(["runner"]).status, 2);
  for (const id of ["abc", "../../etc", "t0000000000"]) {
    const r = run(["runner", id]);
    assert.equal(r.status, 1, id);
    const line = JSON.parse(r.stderr.trim().split("\n").at(-1));
    assert.equal(line.level, "fatal");
    assert.match(line.error, /task not found/);
  }
});

test("entrypoint detection compares canonical paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "claudecode-mcp-entry-"));
  const unrelated = join(dir, "cli.js");
  writeFileSync(unrelated, "// unrelated\n");
  const linked = join(dir, "claudecode-mcp");
  symlinkSync(CLI, linked);
  assert.equal(isMainModule(CLI), true);
  assert.equal(isMainModule(linked), true);
  assert.equal(isMainModule(unrelated), false);
  assert.equal(isMainModule(undefined), false);
});

test("an invalid config stops the server at startup", () => {
  const env = isolatedEnv();
  writeFileSync(env.CLAUDECODE_MCP_CONFIG, JSON.stringify({ max_concurent: 3 }));
  const r = spawnSync(process.execPath, [CLI], {
    env,
    input: "",
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(r.status, 1);
  const line = JSON.parse(r.stderr.trim().split("\n").at(-1));
  assert.equal(line.level, "fatal");
  assert.equal(line.error_class, "ConfigError");
  assert.ok(line.error.includes(env.CLAUDECODE_MCP_CONFIG));
  assert.match(line.error, /max_concurent/);
});

// ── stdio MCP lifecycle ───────────────────────────────────────────────

const children = [];
after(() => {
  for (const c of children) if (!c.killed) c.kill();
});

function startServer(env) {
  const child = spawn(process.execPath, [CLI], { env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const msg = JSON.parse(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let seq = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { child, request };
}

test("stdio: initialize, then tools/list returns no tools yet", async () => {
  const env = isolatedEnv();
  const { child, request } = startServer(env);
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  });
  assert.equal(init.result.serverInfo.name, "claudecode-mcp");
  assert.equal(init.result.serverInfo.version, PKG.version);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await request("tools/list", {});
  assert.deepEqual(list.result.tools, []);

  const call = await request("tools/call", { name: "nope", arguments: {} });
  assert.equal(call.result.isError, true);

  // Startup created the private state dir.
  assert.equal(statSync(join(env.CLAUDECODE_MCP_STATE_DIR, "tasks")).mode & 0o777, 0o700);
  child.kill();
});

test("stdio: a nested server starts but warns that task tools are off", async () => {
  const env = isolatedEnv({ CLAUDECODE_MCP_DEPTH: "1" });
  const { child, request } = startServer(env);
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  });
  assert.ok(init.result);
  assert.match(stderr, /task tools disabled/);
  child.kill();
});
