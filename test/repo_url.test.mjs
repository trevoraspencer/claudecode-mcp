// repo_url parsing, normalization, and allowlist matching (pure functions).

import { test } from "node:test";
import assert from "node:assert/strict";

import { cloneSegments, parseRepoUrl, RepoUrlError, urlAllowed } from "../dist/repo-url.js";

test("accepted forms normalize to one canonical string", () => {
  const h = parseRepoUrl("https://GitHub.com/Owner/Repo.git");
  assert.equal(h.canonical, "https://github.com/Owner/Repo");
  assert.equal(h.cloneUrl, "https://github.com/Owner/Repo.git");
  assert.deepEqual(cloneSegments(h), ["https_github.com", "Owner", "Repo.git"]);
  assert.equal(parseRepoUrl("https://github.com/o/r/").canonical, "https://github.com/o/r");

  // scp paths are home-relative in git: keep the form, keep it distinct.
  const scp = parseRepoUrl("git@github.com:o/r.git");
  assert.equal(scp.scheme, "scp");
  assert.equal(scp.canonical, "git@github.com:o/r");
  assert.equal(scp.cloneUrl, "git@github.com:o/r.git");
  assert.deepEqual(cloneSegments(scp), ["scp_git@github.com", "o", "r.git"]);
  const ssh = parseRepoUrl("ssh://git@github.com/o/r");
  assert.equal(ssh.canonical, "ssh://git@github.com/o/r");
  assert.deepEqual(cloneSegments(ssh), ["ssh_git@github.com", "o", "r.git"]);

  const port = parseRepoUrl("ssh://git@gitlab.example:2222/group/sub/r");
  assert.equal(port.canonical, "ssh://git@gitlab.example:2222/group/sub/r");
  assert.deepEqual(cloneSegments(port), ["ssh_git@gitlab.example_2222", "group", "sub", "r.git"]);

  const file = parseRepoUrl("file:///tmp/x/remote.git", { allowFile: true });
  assert.equal(file.canonical, "file:///tmp/x/remote");
  assert.equal(file.cloneUrl, "file:///tmp/x/remote.git");
  assert.deepEqual(cloneSegments(file), ["file", "tmp", "x", "remote.git"]);

  // One clone can never sit inside another: only the leaf ends in .git.
  const outer = cloneSegments(parseRepoUrl("https://h.example/a/b")).join("/");
  const inner = cloneSegments(parseRepoUrl("https://h.example/a/b/c")).join("/");
  assert.ok(!inner.startsWith(outer + "/"), `${inner} inside ${outer}`);
});

test("dangerous or odd URLs are refused", () => {
  for (const bad of [
    "",
    "ext::sh -c touch% /tmp/pwned",
    "ext::sh",
    "ext::x",
    "https://github.com/o.git/r",
    "https://github.com/.git/r",
    "-u",
    "--upload-pack=touch /tmp/x",
    "http://github.com/o/r",
    "git://github.com/o/r",
    "ftp://github.com/o/r",
    "file:///tmp/x/remote.git",
    "file://host/tmp/x",
    "https://user:pass@github.com/o/r",
    "https://ghp_token@github.com/o/r",
    "ssh://git:pw@github.com/o/r",
    "https://github.com/o/r?x=1",
    "https://github.com/o/r#frag",
    "https://github.com/o/%2e%2e/r",
    "https://github.com/o/../r",
    "https://github.com/o/./r",
    "https://github.com/r",
    "https://github.com/a/b/c/d/e",
    "https://github.com/o/r x",
    "https://github.com/o/-r",
    "https://github.com\\o\\r",
    "git@github.com:/abs/path",
    "git@-oProxyCommand=x:o/r",
    "https://-evil.com/o/r",
    "https://[::1]/o/r",
    "https://github.com/o/r\n",
    "https://" + "a".repeat(2100) + ".com/o/r",
  ]) {
    assert.throws(() => parseRepoUrl(bad), RepoUrlError, JSON.stringify(bad));
  }
  assert.throws(
    () => parseRepoUrl("https://github.com/o/*"),
    RepoUrlError,
    "no * outside patterns",
  );
});

test("allowlist patterns match scheme, user, host, port, and each segment", () => {
  const pats = ["https://github.com/trevoraspencer/*", "git@github.com:trevoraspencer/claude*"].map(
    (p) => parseRepoUrl(p, { pattern: true }),
  );
  const ok = (u) => urlAllowed(parseRepoUrl(u), pats);
  assert.equal(ok("https://github.com/trevoraspencer/claudecode-mcp"), true);
  assert.equal(ok("https://github.com/trevoraspencer/claudecode-mcp.git"), true);
  assert.equal(ok("https://GITHUB.com/trevoraspencer/x"), true);
  assert.equal(ok("git@github.com:trevoraspencer/claudecode-mcp"), true);
  assert.equal(ok("git@github.com:trevoraspencer/other"), false);
  assert.equal(
    ok("ssh://git@github.com/trevoraspencer/claudecode-mcp"),
    false,
    "ssh:// is not scp",
  );
  assert.equal(ok("ssh://github.com/trevoraspencer/claudecode-mcp"), false, "user differs");
  assert.equal(ok("ssh://git@github.com:22/trevoraspencer/claude"), false, "port differs");
  assert.equal(ok("https://github.com/TrevorASpencer/x"), false, "owner is case-sensitive");
  assert.equal(ok("https://github.com/other/x"), false);
  assert.equal(ok("https://github.com/trevoraspencer/x/y"), false);
  assert.equal(ok("https://github.com.evil.com/trevoraspencer/x"), false);
  assert.equal(ok("https://evil.com/github.com/trevoraspencer"), false);
  // Regex metacharacters in patterns are literal.
  const dot = [parseRepoUrl("https://h.example/o/a.b", { pattern: true })];
  assert.equal(urlAllowed(parseRepoUrl("https://h.example/o/axb"), dot), false);
});
