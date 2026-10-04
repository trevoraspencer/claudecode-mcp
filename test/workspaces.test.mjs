// repo_url tasks end to end: managed clones from local bare remotes (file://
// is allowed only through the test-only env switch), real runners, fake claude.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { CLI, sandbox, startServer } from "./_mcp.mjs";
import { addToken, startHttpServer } from "./_http.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** Sandbox with a bare remote holding the sandbox repo's main branch. */
function remoteBox(extraConfig = {}, envExtra = {}) {
  const probe = sandbox();
  const remotes = join(probe.dir, "remotes");
  mkdirSync(remotes);
  const bare = join(remotes, "proj.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  git(probe.repo, "remote", "add", "origin", bare);
  git(probe.repo, "push", "-q", "origin", "main");
  const ws = join(probe.dir, "ws");
  const config = {
    workspaces_dir: ws,
    repo_urls: [`file://${remotes}/*`],
    ...extraConfig,
  };
  const b = sandbox(config, {
    CLAUDECODE_MCP_ALLOW_FILE_URLS: "1",
    CLAUDECODE_MCP_GH_BIN: "/nonexistent/gh",
    ...envExtra,
  });
  return { ...b, remotes, bare, url: `file://${bare}`, src: probe.repo, ws, probeDir: probe.dir };
}

async function server(t, b) {
  const srv = await startServer(b.env);
  t.after(async () => {
    const list = await srv.call("list_tasks", {});
    for (const task of list.json ?? []) {
      if (["running", "idle", "stalled", "starting", "queued"].includes(task.status)) {
        await srv.call("cancel_task", { task_id: task.task_id }, { timeoutMs: 30_000 });
      }
    }
    srv.stop();
  });
  return srv;
}

async function waitIdle(s, id) {
  for (let i = 0; i < 40; i++) {
    const r = await s.call("wait_task", { task_id: id, timeout_s: 5 });
    assert.equal(r.isError, false, r.text);
    if (!r.json.wait_timed_out) return r.json;
  }
  throw new Error("task never settled");
}

// The remote and the clone live in the probe sandbox; allow both sandboxes.
function box(extraConfig = {}, envExtra) {
  const b = remoteBox(extraConfig, envExtra);
  const path = b.env.CLAUDECODE_MCP_CONFIG;
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(
    path,
    JSON.stringify({ ...cfg, allowed_roots: [b.dir, b.probeDir], ...extraConfig }),
  );
  return b;
}

test("start_task with repo_url clones, branches from origin/HEAD, and records the URL", async (t) => {
  const b = box();
  const s = await server(t, b);
  const start = await s.call("start_task", { prompt: "hello", repo_url: b.url });
  assert.equal(start.isError, false, start.text);
  const v = start.json;
  const clone = join(b.ws, "file", ...b.bare.split("/").filter(Boolean));
  assert.ok(existsSync(join(clone, ".git")), "managed clone exists");
  assert.equal(v.workspace.repo_url, `file://${b.bare}`);
  assert.equal(v.workspace.base_commit, git(b.src, "rev-parse", "main"));
  assert.ok(v.workdir.startsWith(join(realpathSync(clone), ".claude", "worktrees")), v.workdir);
  const done = await waitIdle(s, v.task_id);
  assert.equal(done.result.text, "echo: hello");

  const listed = await s.call("list_tasks", { repo_url: b.url });
  assert.deepEqual(
    listed.json.map((x) => [x.task_id, x.repo_url]),
    [[v.task_id, `file://${b.bare}`]],
  );
  assert.deepEqual((await s.call("list_tasks", { repo_url: "file:///nope/x" })).json, []);

  // A new commit and a new branch on the remote: the next task fetches them.
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "two"], { cwd: b.src });
  git(b.src, "push", "-q", "origin", "main");
  git(b.src, "push", "-q", "origin", "main:feature");
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "three"], { cwd: b.src });
  git(b.src, "push", "-q", "origin", "main");
  const next = await s.call("start_task", { prompt: "x", repo_url: b.url });
  assert.equal(next.json.workspace.base_commit, git(b.src, "rev-parse", "main"));
  const feat = await s.call("start_task", { prompt: "x", repo_url: b.url, base_ref: "feature" });
  assert.equal(feat.isError, false, feat.text);
  assert.equal(feat.json.workspace.base_commit, git(b.src, "rev-parse", "main~1"));
});

test("repo_url refusals", async (t) => {
  const b = box();
  const s = await server(t, b);
  const cases = [
    [{ prompt: "x" }, /exactly one of repo or repo_url/],
    [{ prompt: "x", repo: b.repo, repo_url: b.url }, /exactly one of repo or repo_url/],
    [{ prompt: "x", repo_url: b.url, isolation: "in_place" }, /always get a worktree/],
    [{ prompt: "x", repo_url: "file:///elsewhere/proj.git" }, /not in this server's repo_urls/],
    [{ prompt: "x", repo_url: "ext::sh -c id" }, /invalid repo_url/],
    [{ prompt: "x", repo_url: "--upload-pack=id" }, /invalid repo_url/],
    [{ prompt: "x", repo_url: b.url, base_ref: "--output=x" }, /invalid git ref/],
    [{ prompt: "x", repo_url: b.url, base_ref: "nope" }, /unknown git ref/],
  ];
  for (const [args, re] of cases) {
    const r = await s.call("start_task", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re, JSON.stringify(args));
  }
  const ask = await s.call("ask", { prompt: "x", base_ref: "main" });
  assert.match(ask.text, /base_ref needs repo_url/);
  assert.equal((await s.call("list_tasks", {})).json.length, 0, "nothing was created");
});

test("repo_url is off when repo_urls is empty, and file:// needs the test switch", async (t) => {
  const b = box({ repo_urls: [] });
  const s = await server(t, b);
  const r = await s.call("start_task", { prompt: "x", repo_url: b.url });
  assert.match(r.text, /repo_url is not enabled/);

  const c = box({}, { CLAUDECODE_MCP_ALLOW_FILE_URLS: "" });
  const s2 = await server(t, c);
  const r2 = await s2.call("start_task", { prompt: "x", repo_url: c.url });
  assert.match(r2.text, /file:\/\/ URLs are not allowed/);
});

test("workspaces_dir outside allowed_roots stops the server at startup", () => {
  const b = box({ allowed_roots: ["/nonexistent-root"] });
  const r = spawnSync(process.execPath, [CLI], { env: b.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /workspaces_dir is outside allowed_roots/);
});

test("two tasks on a new repo_url at once share one clone", async (t) => {
  const b = box();
  const s = await server(t, b);
  const [a, c] = await Promise.all([
    s.call("start_task", { prompt: "a", repo_url: b.url }, { timeoutMs: 60_000 }),
    s.call("start_task", { prompt: "b", repo_url: b.url }, { timeoutMs: 60_000 }),
  ]);
  assert.equal(a.isError, false, a.text);
  assert.equal(c.isError, false, c.text);
  assert.equal(a.json.workspace.repo_root, c.json.workspace.repo_root);
  const parent = join(a.json.workspace.repo_root, "..");
  assert.deepEqual(readdirSync(parent), ["proj.git"], "no stray temp clones");
});

test("ask with repo_url runs in a temporary checkout that is removed", async (t) => {
  const b = box();
  const s = await server(t, b);
  const r = await s.call("ask", { prompt: "hi", repo_url: b.url }, { timeoutMs: 60_000 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.text, "echo: hi");
  const clone = join(b.ws, "file", ...b.bare.split("/").filter(Boolean));
  const wts = git(clone, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "));
  assert.equal(wts.length, 1, wts.join("\n"));
  assert.deepEqual(readdirSync(join(clone, ".claude", "worktrees")), []);
});

test("close delete checks the remote; push_pr pushes to it; prune-workspaces", async (t) => {
  const b = box();
  const s = await server(t, b);
  const start = await s.call("start_task", {
    prompt: "WRITE a.txt hi\nCOMMIT add a\ndone",
    repo_url: b.url,
  });
  assert.equal(start.isError, false, start.text);
  const id = start.json.task_id;
  const clone = start.json.workspace.repo_root;
  await waitIdle(s, id);

  const prune = (...flags) =>
    spawnSync(process.execPath, [CLI, "prune-workspaces", ...flags], {
      env: b.env,
      encoding: "utf8",
      timeout: 30_000,
    });
  let p = prune();
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^kept\t.*\tused by open task/m);

  const del = await s.call("close_task", { task_id: id, action: "delete" });
  assert.equal(del.isError, true);
  assert.match(del.text, /not on any remote branch/);

  const keep = await s.call("close_task", { task_id: id, action: "keep_branch" });
  assert.equal(keep.isError, false, keep.text);
  p = prune();
  assert.match(p.stdout, /^kept\t.*\t1 local commit\(s\) not on any remote branch/m);
  assert.ok(existsSync(clone));

  // Push the branch from the clone: nothing unpushed is left.
  git(clone, "push", "-q", "origin", start.json.workspace.branch);
  p = prune("--dry-run");
  assert.match(p.stdout, /^would remove\t/m);
  assert.ok(existsSync(clone), "dry run removes nothing");
  p = prune();
  assert.match(p.stdout, /^removed\t/m);
  assert.ok(!existsSync(clone));
});

test("push_pr on a repo_url task pushes the branch to the remote", async (t) => {
  const b = box();
  const s = await server(t, b);
  const start = await s.call("start_task", {
    prompt: "WRITE b.txt hi\nCOMMIT add b\ndone",
    repo_url: b.url,
  });
  await waitIdle(s, start.json.task_id);
  const r = await s.call("close_task", { task_id: start.json.task_id, action: "push_pr" });
  assert.equal(r.isError, false, r.text);
  assert.equal(
    git(b.bare, "rev-parse", start.json.workspace.branch),
    git(start.json.workspace.repo_root, "rev-parse", start.json.workspace.branch),
  );
});

test("repo_url over HTTP mode", async (t) => {
  const b = box({ http: { port: 0 } });
  const token = addToken(b.env);
  const srv = await startHttpServer(b.env, { token });
  t.after(() => srv.stop());
  const start = await srv.call("start_task", { prompt: "hello", repo_url: b.url });
  assert.equal(start.isError, false, start.text);
  for (let i = 0; i < 40; i++) {
    const w = await srv.call("wait_task", { task_id: start.json.task_id, timeout_s: 5 });
    if (!w.json.wait_timed_out) {
      assert.equal(w.json.result.text, "echo: hello");
      break;
    }
  }
  await srv.call("cancel_task", { task_id: start.json.task_id }, { timeoutMs: 30_000 });
});
