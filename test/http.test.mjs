// HTTP mode end to end: built server with --http on a random port, real
// runners, fake claude.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

import { hostOf } from "../dist/http.js";
import { matchToken } from "../dist/http-tokens.js";
import { sandbox } from "./_mcp.mjs";
import { addToken, startHttpServer, tokenCli } from "./_http.mjs";

const HTTP_CONFIG = { http: { port: 0 } };

function box(config = {}, envExtra = {}) {
  const b = sandbox({ ...HTTP_CONFIG, ...config }, envExtra);
  b.tokensFile = join(b.dir, "http-tokens.json");
  return b;
}

async function server(t, config, envExtra) {
  const b = box(config, envExtra);
  const token = addToken(b.env);
  const srv = await startHttpServer(b.env, { token });
  t.after(async () => {
    const list = await srv.call("list_tasks", {}).catch(() => ({}));
    for (const task of list.json ?? []) {
      if (["running", "idle", "stalled", "starting", "queued"].includes(task.status)) {
        await srv.call("cancel_task", { task_id: task.task_id }, { timeoutMs: 30_000 });
      }
    }
    srv.stop();
  });
  return { ...b, ...srv, token };
}

async function waitIdle(s, id) {
  for (let i = 0; i < 40; i++) {
    const r = await s.call("wait_task", { task_id: id, timeout_s: 5 });
    assert.equal(r.isError, false, r.text);
    if (!r.json.wait_timed_out) return r.json;
  }
  throw new Error("task never settled");
}

test("hostOf strips ports and trailing dots, handles IPv6, rejects junk", () => {
  assert.equal(hostOf("LocalHost:8787"), "localhost");
  assert.equal(hostOf("vm.tail.ts.net."), "vm.tail.ts.net");
  assert.equal(hostOf("vm.tail.ts.net.:443"), "vm.tail.ts.net");
  assert.equal(hostOf("[::1]:8787"), "::1");
  assert.equal(hostOf("[::1]"), "::1");
  assert.equal(hostOf(undefined), undefined);
  assert.equal(hostOf(""), undefined);
  assert.equal(hostOf("[::1]junk"), undefined);
  assert.equal(hostOf("a:b:c"), undefined);
  assert.equal(hostOf("a b"), undefined);
});

test("matchToken accepts only well-formed known tokens", () => {
  const b = box();
  const token = addToken(b.env, "one");
  const entries = JSON.parse(readFileSync(b.tokensFile, "utf8")).tokens;
  assert.equal(matchToken(entries, token), "one");
  assert.equal(
    matchToken(entries, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")),
    undefined,
  );
  assert.equal(matchToken(entries, ""), undefined);
  assert.equal(matchToken(entries, "x".repeat(10_000)), undefined);
  assert.equal(matchToken([], token), undefined);
});

test("token CLI: add prints once, stores only a hash at 0600; list and revoke", () => {
  const b = box();
  const token = addToken(b.env, "macbook");
  assert.match(token, /^ccm_[A-Za-z0-9_-]{43}$/);
  const raw = readFileSync(b.tokensFile, "utf8");
  assert.doesNotMatch(raw, new RegExp(token.slice(4)));
  assert.equal(statSync(b.tokensFile).mode & 0o777, 0o600);
  const file = JSON.parse(raw);
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.tokens[0]).sort(), ["created_at", "name", "sha256"]);

  addToken(b.env, "phone");
  const list = tokenCli(b.env, "list");
  assert.equal(list.status, 0);
  assert.match(list.stdout, /^macbook\t.*\nphone\t/);
  assert.doesNotMatch(list.stdout, /ccm_|[0-9a-f]{64}/);

  const dup = tokenCli(b.env, "add", "macbook");
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /already exists/);
  assert.equal(tokenCli(b.env, "add", "bad name").status, 1);
  assert.equal(tokenCli(b.env, "add").status, 2);
  assert.equal(tokenCli(b.env, "list", "extra").status, 2);
  assert.equal(tokenCli(b.env, "bogus").status, 2);

  assert.equal(tokenCli(b.env, "revoke", "macbook").status, 0);
  assert.equal(tokenCli(b.env, "revoke", "macbook").status, 1);
  assert.match(tokenCli(b.env, "list").stdout, /^phone\t[^\n]*\n$/);
});

test("--http refuses to start without tokens, with an open tokens file, or nested", async () => {
  const b = box();
  await assert.rejects(startHttpServer(b.env), /no tokens; create one/);
  addToken(b.env);
  chmodSync(b.tokensFile, 0o644);
  await assert.rejects(startHttpServer(b.env), /mode 644 is too open/);
  chmodSync(b.tokensFile, 0o600);
  await assert.rejects(
    startHttpServer({ ...b.env, CLAUDECODE_MCP_DEPTH: "1" }),
    /refuses to start inside a delegated task/,
  );
});

test("auth: missing, wrong, and revoked tokens get 401; a valid one works", async (t) => {
  const s = await server(t);
  const none = await s.post("tools/list", {}, { token: null });
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate"), /^Bearer/);
  assert.equal((await s.post("tools/list", {}, { token: "ccm_" + "A".repeat(43) })).status, 401);
  assert.equal((await s.post("tools/list", {}, { token: "garbage" })).status, 401);
  assert.equal(
    (await s.post("tools/list", {}, { headers: { authorization: `Basic ${s.token}` } })).status,
    401,
  );

  const ok = await s.post("tools/list", {});
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.messages.at(-1).result.tools.length, 10);

  // Revoke without restart: the server re-reads the tokens file.
  const other = addToken(s.env, "second");
  assert.equal((await s.post("tools/list", {}, { token: other })).status, 200);
  assert.equal(tokenCli(s.env, "revoke", "second").status, 0);
  assert.equal((await s.post("tools/list", {}, { token: other })).status, 401);
  assert.equal((await s.post("tools/list", {})).status, 200);

  // A tokens file that becomes unsafe fails closed until it is fixed.
  chmodSync(s.tokensFile, 0o644);
  assert.equal((await s.post("tools/list", {})).status, 401);
  chmodSync(s.tokensFile, 0o600);
  assert.equal((await s.post("tools/list", {})).status, 200);

  // The token never appears in the server's logs.
  assert.doesNotMatch(s.stderr(), new RegExp(s.token.slice(4)));
});

test("Host and Origin checks; allowed_hosts and allowed_origins", async (t) => {
  const s = await server(t, {
    http: {
      port: 0,
      allowed_hosts: ["vm.tail1234.ts.net"],
      allowed_origins: ["https://ok.example"],
    },
  });
  // fetch cannot override Host, so use node:http for the Host cases.
  const withHost = (host) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      const req = request(
        {
          host: "127.0.0.1",
          port: s.port,
          path: "/mcp",
          method: "POST",
          headers: {
            host,
            authorization: `Bearer ${s.token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  assert.equal(await withHost("evil.example"), 403);
  assert.equal(await withHost("evil.example:8787"), 403);
  assert.equal(await withHost("vm.tail1234.ts.net"), 200);
  assert.equal(await withHost("VM.tail1234.ts.net.:443"), 200);
  assert.equal(await withHost("localhost:1"), 200);

  const bad = await s.post("tools/list", {}, { headers: { origin: "https://evil.example" } });
  assert.equal(bad.status, 403);
  const good = await s.post("tools/list", {}, { headers: { origin: "https://ok.example" } });
  assert.equal(good.status, 200);
});

test("healthz needs no auth; other paths 404; GET 405; bad JSON 400; big body 413", async (t) => {
  const s = await server(t);
  const h = await fetch(`${s.base}/healthz`);
  assert.equal(h.status, 200);
  assert.equal(await h.text(), "ok\n");
  assert.equal((await fetch(`${s.base}/other`)).status, 404);
  assert.equal(
    (await fetch(`${s.base}/mcp`, { headers: { authorization: `Bearer ${s.token}` } })).status,
    405,
  );
  // Auth comes before the method check: no hint to strangers.
  assert.equal((await fetch(`${s.base}/mcp`)).status, 401);
  assert.equal((await s.post("x", {}, { body: "{not json" })).status, 400);

  // Declared too large: refused before the body is read.
  const status = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: s.port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: `Bearer ${s.token}`,
          "content-type": "application/json",
          "content-length": 9 * 1024 * 1024,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
        req.destroy();
      },
    );
    req.on("error", reject);
    req.flushHeaders();
  });
  assert.equal(status, 413);

  // Streamed (chunked) past the cap: refused while reading.
  const chunked = await new Promise((resolve) => {
    let done = false;
    const req = request(
      {
        host: "127.0.0.1",
        port: s.port,
        path: "/mcp",
        method: "POST",
        headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
      },
      (res) => {
        done = true;
        res.resume();
        resolve(res.statusCode);
        req.destroy();
      },
    );
    req.on("error", () => {
      if (!done) resolve("error");
    });
    const chunk = Buffer.alloc(1024 * 1024, 32);
    (async () => {
      for (let i = 0; i < 10 && !done; i++) {
        if (!req.write(chunk)) await new Promise((r) => req.once("drain", r));
      }
    })().catch(() => {});
  });
  assert.equal(chunked, 413);

  // The server is still healthy after all that.
  assert.equal((await s.post("tools/list", {})).status, 200);
});

test("start_task, wait_task, get_diff end to end over HTTP", async (t) => {
  const s = await server(t);
  const start = await s.call("start_task", {
    prompt: "WRITE a.txt hi\nCOMMIT add a\nhello",
    repo: s.repo,
  });
  assert.equal(start.isError, false, start.text);
  const done = await waitIdle(s, start.json.task_id);
  assert.equal(done.status, "idle");
  const diff = await s.call("get_diff", { task_id: start.json.task_id });
  assert.equal(diff.isError, false, diff.text);
  assert.match(JSON.stringify(diff.json), /a\.txt/);
});

test("ask streams progress notifications as SSE", async (t) => {
  const s = await server(t);
  const r = await s.call(
    "ask",
    { prompt: "SLOW 11000", timeout_s: 30 },
    { progressToken: "p1", timeoutMs: 30_000 },
  );
  assert.equal(r.isError, false, r.text);
  const progress = r.notifications.filter((n) => n.method === "notifications/progress");
  assert.ok(progress.length >= 1, JSON.stringify(r.notifications));
  assert.equal(progress[0].params.progressToken, "p1");
});

test("tool errors stay redacted and capped over HTTP", async (t) => {
  const s = await server(t, {}, { ANTHROPIC_API_KEY: "sk-ant-FAKESECRET" });
  const crash = await s.call("ask", { prompt: "CRASH" });
  assert.equal(crash.isError, true);
  assert.doesNotMatch(crash.text, /FAKESECRET/);
});

test("SIGTERM: in-flight requests finish, the server exits 0, runners survive", async (t) => {
  const b = box({}, { CLAUDECODE_MCP_HTTP_GRACE_MS: "15000" });
  const token = addToken(b.env);
  const first = await startHttpServer(b.env, { token });
  t.after(() => first.stop());
  const start = await first.call("start_task", { prompt: "SLOW 4000", repo: b.repo });
  assert.equal(start.isError, false, start.text);
  const id = start.json.task_id;
  for (let i = 0; i < 40; i++) {
    const v = await first.call("get_task", { task_id: id });
    if (v.json.status === "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // A wait in flight when SIGTERM arrives still gets its answer.
  const waiting = first.call("wait_task", { task_id: id, timeout_s: 2 });
  await new Promise((r) => setTimeout(r, 300));
  first.child.kill("SIGTERM");
  const waited = await waiting;
  assert.equal(waited.isError, false, waited.text);
  assert.equal(waited.json.task_id, id);
  const exit = await first.exited;
  assert.equal(exit.code, 0, first.stderr());
  assert.match(first.stderr(), /"phase":"http_stopped","unfinished":0/);

  // The runner kept going; a new server sees the turn finish.
  const second = await startHttpServer(b.env, { token });
  t.after(async () => {
    await second.call("cancel_task", { task_id: id }, { timeoutMs: 30_000 }).catch(() => {});
    second.stop();
  });
  const done = await waitIdle(second, id);
  assert.equal(done.status, "idle");
  assert.equal(done.result.is_error, false);
});

test("a client disconnect aborts the server-side wait", async (t) => {
  const s = await server(t, {}, { DEBUG: "claudecode-mcp" });
  const start = await s.call("start_task", { prompt: "HANG", repo: s.repo });
  assert.equal(start.isError, false, start.text);
  const ac = new AbortController();
  const pending = s.call(
    "wait_task",
    { task_id: start.json.task_id, timeout_s: 50 },
    { signal: ac.signal },
  );
  await new Promise((r) => setTimeout(r, 500));
  ac.abort();
  await assert.rejects(pending);
  let line;
  for (let i = 0; i < 50 && !line; i++) {
    await new Promise((r) => setTimeout(r, 100));
    line = s
      .stderr()
      .split("\n")
      .find((l) => l.includes('"phase":"call_done"') && l.includes('"tool":"wait_task"'));
  }
  assert.ok(line, "wait_task ended after the disconnect");
  assert.ok(JSON.parse(line).duration_ms < 10_000, line);
});
