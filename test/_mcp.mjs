// Helpers: start the built server over stdio and call tools with JSON-RPC.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = join(HERE, "..", "dist", "cli.js");
export const STUB = join(HERE, "_fake_claude.mjs");

/** Make `dir` a git repo with one commit (README.md). */
export function initRepo(dir) {
  const g = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("config", "user.name", "t");
  g("config", "user.email", "t@t");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hello\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return g;
}

/** A short-path sandbox (unix socket limit) with config, state dir, and a git repo. */
export function sandbox(config = {}, envExtra = {}) {
  const dir = mkdtempSync("/tmp/ccm-");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const g = initRepo(repo);
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ allowed_roots: [dir], ...config }));
  const env = {
    ...process.env,
    CLAUDECODE_MCP_CONFIG: configPath,
    CLAUDECODE_MCP_STATE_DIR: join(dir, "s"),
    CLAUDECODE_MCP_CLAUDE_BIN: STUB,
    CLAUDECODE_MCP_FAKE_ARGV_OUT: join(dir, "argv.jsonl"),
    CLAUDECODE_MCP_DEPTH: "",
    ...envExtra,
  };
  return { dir, repo, env, g };
}

export async function startServer(env) {
  const child = spawn(process.execPath, [CLI], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  let buf = "";
  const waiting = new Map();
  const notifications = [];
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const msg = JSON.parse(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
      if (msg.id !== undefined && waiting.has(msg.id)) waiting.get(msg.id)(msg);
      else if (msg.method) notifications.push(msg);
    }
  });
  let seq = 0;
  const request = (method, params, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}\n${stderr}`)), timeoutMs);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  /** Call a tool; returns { isError, text, json }. */
  const call = async (name, args = {}, opts = {}) => {
    const params = {
      name,
      arguments: args,
      ...(opts.progressToken ? { _meta: { progressToken: opts.progressToken } } : {}),
    };
    const msg = await request("tools/call", params, opts.timeoutMs ?? 20_000);
    if (msg.error) return { isError: true, text: msg.error.message, rpcError: msg.error };
    const text = msg.result.content?.[0]?.text ?? "";
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: msg.result.isError === true, text, json };
  };
  const stop = () => child.kill();
  return { child, request, call, stop, notifications, stderr: () => stderr };
}
