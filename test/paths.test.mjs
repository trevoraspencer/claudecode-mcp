import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  configPath,
  ensureStateDir,
  expandHome,
  StateDirError,
  stateDir,
  tasksDir,
} from "../dist/paths.js";

test("expandHome handles ~ and ~/ only", () => {
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("~/a/b", "/h"), "/h/a/b");
  assert.equal(expandHome("~bob/a", "/h"), "~bob/a");
  assert.equal(expandHome("/abs", "/h"), "/abs");
});

test("default locations follow XDG and ignore relative XDG values", () => {
  assert.equal(configPath({}), join(homedir(), ".config", "claudecode-mcp", "config.json"));
  assert.equal(stateDir({}), join(homedir(), ".local", "state", "claudecode-mcp"));
  assert.equal(configPath({ XDG_CONFIG_HOME: "/x" }), "/x/claudecode-mcp/config.json");
  assert.equal(stateDir({ XDG_STATE_HOME: "/s" }), "/s/claudecode-mcp");
  assert.equal(
    stateDir({ XDG_STATE_HOME: "rel" }),
    join(homedir(), ".local", "state", "claudecode-mcp"),
  );
  assert.equal(tasksDir({ XDG_STATE_HOME: "/s" }), "/s/claudecode-mcp/tasks");
});

test("overrides win over XDG", () => {
  assert.equal(configPath({ CLAUDECODE_MCP_CONFIG: "/c.json", XDG_CONFIG_HOME: "/x" }), "/c.json");
  assert.equal(stateDir({ CLAUDECODE_MCP_STATE_DIR: "/st", XDG_STATE_HOME: "/s" }), "/st");
});

test("ensureStateDir creates private dirs and tightens loose modes", () => {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-state-"));
  const env = { CLAUDECODE_MCP_STATE_DIR: join(root, "state") };
  const base = ensureStateDir(env);
  assert.equal(base, join(root, "state"));
  assert.equal(statSync(base).mode & 0o777, 0o700);
  assert.equal(statSync(join(base, "tasks")).mode & 0o777, 0o700);

  chmodSync(base, 0o755);
  ensureStateDir(env);
  assert.equal(statSync(base).mode & 0o777, 0o700);
});

test("ensureStateDir refuses a symlink or a file", () => {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-state-"));
  const real = mkdtempSync(join(tmpdir(), "claudecode-mcp-real-"));
  const link = join(root, "link");
  symlinkSync(real, link);
  assert.throws(() => ensureStateDir({ CLAUDECODE_MCP_STATE_DIR: link }), StateDirError);

  const file = join(root, "file");
  writeFileSync(file, "");
  assert.throws(() => ensureStateDir({ CLAUDECODE_MCP_STATE_DIR: file }));
});
