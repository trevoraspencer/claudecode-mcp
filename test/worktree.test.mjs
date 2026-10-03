// Worktree isolation, get_diff, and close_task over MCP with real git repos.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { sandbox, startServer } from "./_mcp.mjs";

async function server(t, envExtra = {}) {
  const box = sandbox({}, envExtra);
  const srv = await startServer(box.env);
  t.after(async () => {
    const list = await srv.call("list_tasks", {});
    for (const task of list.json ?? []) {
      if (["running", "idle", "stalled", "starting"].includes(task.status)) {
        await srv.call("cancel_task", { task_id: task.task_id }, { timeoutMs: 30_000 });
      }
    }
    srv.stop();
  });
  return { ...box, ...srv };
}

async function run(s, prompt, extra = {}) {
  const start = await s.call("start_task", { prompt, repo: s.repo, ...extra });
  assert.equal(start.isError, false, start.text);
  const id = start.json.task_id;
  for (let i = 0; i < 40; i++) {
    const r = await s.call("wait_task", { task_id: id, timeout_s: 5 });
    if (!r.json.wait_timed_out) return r.json;
  }
  throw new Error("task never settled");
}

test("a worktree task runs on its own branch, hidden from git status", async (t) => {
  const s = await server(t);
  const v = await run(s, "WRITE new.txt from the task", { name: "Add New File!" });
  const ws = v.workspace;
  assert.equal(ws.isolation, "worktree");
  assert.match(ws.branch, /^claude\/add-new-file-[0-9a-z]{6}$/);
  assert.equal(ws.base_commit, s.g("rev-parse", "HEAD").trim());
  assert.equal(readFileSync(join(ws.worktree, "new.txt"), "utf8"), "from the task\n");
  assert.equal(existsSync(join(s.repo, "new.txt")), false, "main checkout untouched");
  assert.equal(s.g("status", "--porcelain"), "", "worktrees are excluded from status");
  assert.match(
    readFileSync(join(s.repo, ".git", "info", "exclude"), "utf8"),
    /^\/\.claude\/worktrees\/$/m,
  );
});

test("non-git folders need in_place; in_place works there", async (t) => {
  const s = await server(t);
  const plain = join(s.dir, "plain");
  mkdirSync(plain);
  const r = await s.call("start_task", { prompt: "x", repo: plain });
  assert.equal(r.isError, true);
  assert.match(r.text, /not a git repository.*in_place/);
  const ok = await s.call("start_task", { prompt: "x", repo: plain, isolation: "in_place" });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(ok.json.workspace, { isolation: "in_place", title: "x" });
  const diff = await s.call("get_diff", { task_id: ok.json.task_id });
  assert.match(diff.text, /not in a git repo/);
  await s.call("cancel_task", { task_id: ok.json.task_id });
});

test("base_ref picks the starting commit; bad refs are refused", async (t) => {
  const s = await server(t);
  const first = s.g("rev-parse", "HEAD").trim();
  writeFileSync(join(s.repo, "later.txt"), "later\n");
  s.g("add", "-A");
  s.g("commit", "-qm", "later");
  const v = await run(s, "hi", { base_ref: first });
  assert.equal(v.workspace.base_commit, first);
  assert.equal(existsSync(join(v.workspace.worktree, "later.txt")), false);
  for (const ref of ["--output=/tmp/x", "nope-branch", "a b"]) {
    const r = await s.call("start_task", { prompt: "x", repo: s.repo, base_ref: ref });
    assert.equal(r.isError, true, ref);
  }
  const r = await s.call("start_task", {
    prompt: "x",
    repo: s.repo,
    isolation: "in_place",
    base_ref: first,
  });
  assert.match(r.text, /base_ref needs isolation/);
});

test("a subfolder repo path starts Claude in the same subfolder of the worktree", async (t) => {
  const s = await server(t);
  mkdirSync(join(s.repo, "pkg"));
  writeFileSync(join(s.repo, "pkg", "a.txt"), "a\n");
  s.g("add", "-A");
  s.g("commit", "-qm", "pkg");
  const start = await s.call("start_task", { prompt: "hi", repo: join(s.repo, "pkg") });
  assert.match(start.json.workdir, /\/worktrees\/t[0-9a-z]{10}\/pkg$/);
  await s.call("cancel_task", { task_id: start.json.task_id });
});

test("get_diff shows commits, tracked and untracked changes; stat_only and caps", async (t) => {
  const s = await server(t);
  const v = await run(
    s,
    "WRITE README.md changed\nWRITE committed.txt c\nCOMMIT add committed\nWRITE loose.txt loose",
  );
  const full = await s.call("get_diff", { task_id: v.task_id });
  assert.equal(full.isError, false, full.text);
  const d = full.json;
  assert.deepEqual(
    d.commits.map((c) => c.replace(/^\w+ /, "")),
    ["add committed"],
  );
  assert.match(d.stat, /README\.md/);
  assert.match(d.stat, /committed\.txt/);
  assert.deepEqual(d.untracked, ["loose.txt"]);
  assert.match(d.diff, /\+changed/);
  assert.match(d.diff, /\+loose/);
  assert.equal(d.diff_truncated, undefined);
  const stat = await s.call("get_diff", { task_id: v.task_id, stat_only: true });
  assert.equal(stat.json.diff, undefined);

  await s.call("send_message", {
    task_id: v.task_id,
    text: `WRITE big.txt ${"x".repeat(300_000)}`,
  });
  for (let i = 0; i < 20; i++) {
    const w = await s.call("wait_task", { task_id: v.task_id, timeout_s: 5 });
    if (!w.json.wait_timed_out && w.json.turns === 2) break;
  }
  const big = await s.call("get_diff", { task_id: v.task_id });
  assert.equal(big.json.diff_truncated, true);
  assert.ok(Buffer.byteLength(big.json.diff) <= 200 * 1024);
  assert.ok(big.json.diff_full_bytes > 300_000);
});

test("close keep_branch removes the folder, keeps the branch, and ends the task", async (t) => {
  const s = await server(t);
  const v = await run(s, "WRITE a.txt a\nCOMMIT a");
  const r = await s.call("close_task", { task_id: v.task_id });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.removed, v.workspace.worktree);
  assert.equal(existsSync(v.workspace.worktree), false);
  assert.match(s.g("branch", "--list", v.workspace.branch), /claude\//);
  assert.equal(r.json.task.status, "closed");
  const again = await s.call("send_message", { task_id: v.task_id, text: "more" });
  assert.match(again.text, /closed/);
  const twice = await s.call("close_task", { task_id: v.task_id });
  assert.deepEqual(twice.json.notes, ["already closed"]);
});

test("close refuses uncommitted changes unless force", async (t) => {
  const s = await server(t);
  const v = await run(s, "WRITE dirty.txt d");
  const r = await s.call("close_task", { task_id: v.task_id });
  assert.equal(r.isError, true);
  assert.match(r.text, /uncommitted changes \(1 files: dirty\.txt\)/);
  assert.ok(existsSync(v.workspace.worktree));
  const forced = await s.call("close_task", { task_id: v.task_id, force: true });
  assert.equal(forced.isError, false, forced.text);
  assert.equal(existsSync(v.workspace.worktree), false);
});

test("close delete refuses unmerged commits unless force; deletes clean branches", async (t) => {
  const s = await server(t);
  const v = await run(s, "WRITE a.txt a\nCOMMIT a");
  const r = await s.call("close_task", { task_id: v.task_id, action: "delete" });
  assert.match(r.text, /1 commit\(s\) not in the repo's HEAD/);
  const forced = await s.call("close_task", { task_id: v.task_id, action: "delete", force: true });
  assert.equal(forced.json.branch_deleted, v.workspace.branch);
  assert.equal(s.g("branch", "--list", v.workspace.branch), "");

  const clean = await run(s, "nothing");
  const del = await s.call("close_task", { task_id: clean.task_id, action: "delete" });
  assert.equal(del.isError, false, del.text);
  assert.equal(del.json.branch_deleted, clean.workspace.branch);
});

test("close stops a running task first", async (t) => {
  const s = await server(t);
  const start = await s.call("start_task", { prompt: "HANG", repo: s.repo });
  const r = await s.call("close_task", { task_id: start.json.task_id }, { timeoutMs: 30_000 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.task.status, "closed");
  assert.equal(r.json.task.runner_alive, false);
});

test("close push_pr pushes the branch and opens a draft PR with gh", async (t) => {
  const fakeGh = join("/tmp", `ccm-gh-${process.pid}.sh`);
  const ghArgs = join("/tmp", `ccm-gh-${process.pid}.args`);
  writeFileSync(
    fakeGh,
    '#!/bin/sh\necho "$@" > "$FAKE_GH_ARGS"\necho https://github.com/o/r/pull/42\n',
  );
  chmodSync(fakeGh, 0o755);
  const s = await server(t, { CLAUDECODE_MCP_GH_BIN: fakeGh, FAKE_GH_ARGS: ghArgs });
  const remote = join(s.dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  s.g("remote", "add", "origin", remote);
  const v = await run(s, "WRITE f.txt f\nCOMMIT feature", { name: "Feature X" });
  const r = await s.call("close_task", { task_id: v.task_id, action: "push_pr" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.pushed, v.workspace.branch);
  assert.equal(r.json.pr_url, "https://github.com/o/r/pull/42");
  assert.match(
    execFileSync("git", ["--git-dir", remote, "branch"]).toString(),
    /claude\/feature-x/,
  );
  assert.match(
    readFileSync(ghArgs, "utf8"),
    /pr create --draft --head=claude\/feature-x-\w+ --title=Feature X/,
  );
  assert.equal(existsSync(v.workspace.worktree), false);
});

test("push_pr without gh still pushes and says so", async (t) => {
  const s = await server(t, { CLAUDECODE_MCP_GH_BIN: "/nonexistent/gh" });
  const remote = join(s.dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  s.g("remote", "add", "origin", remote);
  const v = await run(s, "WRITE f.txt f\nCOMMIT f");
  const r = await s.call("close_task", { task_id: v.task_id, action: "push_pr" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.pushed, v.workspace.branch);
  assert.match(r.json.notes[0], /gh is not installed/);
});

test("in_place tasks in a git repo get a diff; delete/push_pr are refused", async (t) => {
  const s = await server(t);
  const v = await run(s, "WRITE inplace.txt here", { isolation: "in_place" });
  assert.equal(v.workspace.isolation, "in_place");
  const d = await s.call("get_diff", { task_id: v.task_id });
  assert.deepEqual(d.json.untracked, ["inplace.txt"]);
  const r = await s.call("close_task", { task_id: v.task_id, action: "delete" });
  assert.match(r.text, /no worktree/);
  const ok = await s.call("close_task", { task_id: v.task_id });
  assert.equal(ok.isError, false, ok.text);
  assert.ok(existsSync(join(s.repo, "inplace.txt")), "in_place files stay");
});

// ── regressions from review ───────────────────────────────────────────

test("a symlinked .claude folder is refused", async (t) => {
  const s = await server(t);
  const elsewhere = join(s.dir, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(s.repo, ".claude"));
  const r = await s.call("start_task", { prompt: "x", repo: s.repo });
  assert.equal(r.isError, true);
  assert.match(r.text, /through a symlink/);
});

test("close cleans up after a worktree folder was deleted by hand", async (t) => {
  const s = await server(t);
  const v = await run(s, "nothing");
  await s.call("cancel_task", { task_id: v.task_id });
  rmSync(v.workspace.worktree, { recursive: true, force: true });
  const d = await s.call("get_diff", { task_id: v.task_id });
  assert.match(d.text, /folder is missing/);
  const r = await s.call("close_task", { task_id: v.task_id, action: "delete" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.branch_deleted, v.workspace.branch);
  assert.equal(s.g("worktree", "list").includes(v.task_id), false);
});

test("a message racing close_task never resumes the task", async (t) => {
  const s = await server(t);
  const v = await run(s, "nothing");
  const [closed, msg] = await Promise.all([
    s.call("close_task", { task_id: v.task_id }, { timeoutMs: 30_000 }),
    (async () => {
      await new Promise((r) => setTimeout(r, 20));
      return s.call("send_message", { task_id: v.task_id, text: "WRITE late.txt late" });
    })(),
  ]);
  assert.equal(closed.isError, false, closed.text);
  const final = (await s.call("get_task", { task_id: v.task_id })).json;
  assert.equal(final.status, "closed");
  assert.equal(final.runner_alive, false);
  if (!msg.isError) {
    // The message reached the runner before close cancelled it; nothing may run after close.
    assert.notEqual(msg.json.delivery, "resumed");
  }
  assert.equal(existsSync(v.workspace.worktree), false);
});

test("gh gets --flag=value args, so a leading dash in the title is safe", async (t) => {
  const fakeGh = join("/tmp", `ccm-gh2-${process.pid}.sh`);
  const ghArgs = join("/tmp", `ccm-gh2-${process.pid}.args`);
  writeFileSync(
    fakeGh,
    '#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "$FAKE_GH_ARGS"\necho https://x/pull/1\n',
  );
  chmodSync(fakeGh, 0o755);
  const s = await server(t, { CLAUDECODE_MCP_GH_BIN: fakeGh, FAKE_GH_ARGS: ghArgs });
  const remote = join(s.dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  s.g("remote", "add", "origin", remote);
  const v = await run(s, "WRITE f.txt f\nCOMMIT f", { name: "--web" });
  const r = await s.call("close_task", { task_id: v.task_id, action: "push_pr" });
  assert.equal(r.isError, false, r.text);
  const args = readFileSync(ghArgs, "utf8").split("\n");
  assert.ok(args.includes("--title=--web"), args.join(" "));
  assert.equal(args.includes("--web"), false);
});

// ── regressions from the independent review ───────────────────────────

test("a task's own worktree cannot be the repo for another worktree task", async (t) => {
  const s = await server(t);
  const a = await run(s, "nothing");
  const r = await s.call("start_task", { prompt: "x", repo: a.workspace.worktree });
  assert.equal(r.isError, true);
  assert.match(r.text, /linked worktree/);
});

test("close refuses when another worktree sits inside the task's folder", async (t) => {
  const s = await server(t);
  const a = await run(s, "nothing");
  const inner = join(a.workspace.worktree, "inner");
  s.g("worktree", "add", "-q", "-b", "other", inner);
  const r = await s.call("close_task", { task_id: a.task_id, force: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /contains other worktrees/);
  assert.ok(existsSync(inner));
});

test("close refuses a worktree whose HEAD left the task branch", async (t) => {
  const s = await server(t);
  const v = await run(s, "GIT checkout -q --detach\nWRITE x.txt x\nCOMMIT detached work");
  const r = await s.call("close_task", { task_id: v.task_id });
  assert.equal(r.isError, true);
  assert.match(r.text, /detached HEAD/);
  assert.ok(existsSync(v.workspace.worktree));
  const forced = await s.call("close_task", { task_id: v.task_id, force: true });
  assert.equal(forced.isError, false, forced.text);
});

test("a failed push leaves the task closing (not resumable); a retry finishes", async (t) => {
  const s = await server(t, { CLAUDECODE_MCP_GH_BIN: "/nonexistent/gh" });
  const v = await run(s, "WRITE f.txt f\nCOMMIT f");
  const r = await s.call("close_task", { task_id: v.task_id, action: "push_pr" });
  assert.equal(r.isError, true);
  assert.match(r.text, /push failed.*closing/s);
  assert.equal((await s.call("get_task", { task_id: v.task_id })).json.status, "closing");
  const msg = await s.call("send_message", { task_id: v.task_id, text: "more" });
  assert.match(msg.text, /closing/);
  const remote = join(s.dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  s.g("remote", "add", "origin", remote);
  const retry = await s.call("close_task", { task_id: v.task_id, action: "push_pr" });
  assert.equal(retry.isError, false, retry.text);
  assert.equal(retry.json.task.status, "closed");
});

test("untracked diffs ignore a configured external diff tool", async (t) => {
  const s = await server(t);
  s.g("config", "diff.external", "/bin/echo");
  const v = await run(s, "WRITE new.txt fresh");
  const d = await s.call("get_diff", { task_id: v.task_id });
  assert.match(d.json.diff, /\+fresh/);
});

test("repos with no commits: worktree is refused, in_place works", async (t) => {
  const s = await server(t);
  const empty = join(s.dir, "empty");
  mkdirSync(empty);
  execFileSync("git", ["init", "-q"], { cwd: empty });
  const r = await s.call("start_task", { prompt: "x", repo: empty });
  assert.match(r.text, /no commits yet/);
  const ok = await s.call("start_task", { prompt: "x", repo: empty, isolation: "in_place" });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(ok.json.workspace.base_commit, undefined);
  const d = await s.call("get_diff", { task_id: ok.json.task_id });
  assert.match(d.text, /no base commit/);
});

test("an untracked subfolder fails cleanly and leaves no branch behind", async (t) => {
  const s = await server(t);
  mkdirSync(join(s.repo, "build"));
  const r = await s.call("start_task", { prompt: "x", repo: join(s.repo, "build") });
  assert.equal(r.isError, true);
  assert.match(r.text, /does not exist in the new worktree/);
  assert.equal(s.g("branch", "--list", "claude/*"), "");
  assert.equal(s.g("worktree", "list").trim().split("\n").length, 1);
});

test("secrets in the prompt never reach the branch name", async (t) => {
  const s = await server(t);
  const v = await run(s, "use key sk-ant-SECRETVALUE123 please");
  assert.doesNotMatch(v.workspace.branch, /SECRETVALUE|secretvalue/);
  assert.doesNotMatch(v.workspace.title, /SECRETVALUE/);
});
