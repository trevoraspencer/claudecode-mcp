// Helpers: start the built server in HTTP mode and call it with fetch.

import { spawn, spawnSync } from "node:child_process";
import { CLI } from "./_mcp.mjs";

/** Run `claudecode-mcp token ...`; returns spawnSync's result. */
export function tokenCli(env, ...args) {
  return spawnSync(process.execPath, [CLI, "token", ...args], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

/** Add a device token and return it. */
export function addToken(env, name = "test-device") {
  const r = tokenCli(env, "add", name);
  if (r.status !== 0) throw new Error(`token add failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Parse a Streamable HTTP response body (SSE or JSON) into JSON-RPC messages. */
export function parseMessages(contentType, text) {
  if ((contentType ?? "").includes("text/event-stream")) {
    return text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
  }
  return text ? [JSON.parse(text)] : [];
}

/** Start `cli.js --http` and wait for its listening line. */
export async function startHttpServer(env, { token } = {}) {
  const child = spawn(process.execPath, [CLI, "--http"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line:\n${stderr}`)), 15_000);
    child.stderr.on("data", (c) => {
      stderr += c;
      const m = /"phase":"http_listening".*?"port":(\d+)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}):\n${stderr}`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let seq = 0;

  /** Raw POST of a JSON-RPC request. Returns { status, headers, messages, text }. */
  const post = async (method, params, opts = {}) => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? token}` }),
      ...(opts.headers ?? {}),
    };
    const res = await fetch(base + (opts.path ?? "/mcp"), {
      method: "POST",
      headers,
      body: opts.body ?? JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    let messages = [];
    try {
      messages = parseMessages(res.headers.get("content-type"), text);
    } catch {
      // error bodies from the auth layer are plain JSON; leave unparsed ones empty
    }
    return { status: res.status, headers: res.headers, messages, text };
  };

  /** Call a tool; returns { isError, text, json, notifications }. */
  const call = async (name, args = {}, opts = {}) => {
    const params = {
      name,
      arguments: args,
      ...(opts.progressToken ? { _meta: { progressToken: opts.progressToken } } : {}),
    };
    const r = await post("tools/call", params, opts);
    if (r.status !== 200) return { isError: true, status: r.status, text: r.text };
    const reply = r.messages.find((m) => m.id !== undefined);
    const notifications = r.messages.filter((m) => m.method);
    if (reply.error) return { isError: true, text: reply.error.message, notifications };
    const text = reply.result.content?.[0]?.text ?? "";
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: reply.result.isError === true, text, json, notifications };
  };

  const stop = () => child.kill("SIGKILL");
  return { child, port, base, post, call, stop, exited, stderr: () => stderr };
}
