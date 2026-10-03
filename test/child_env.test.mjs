import { test } from "node:test";
import assert from "node:assert/strict";

import { buildChildEnv, isNeverForwarded } from "../dist/child-env.js";

const BASE = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  XDG_CONFIG_HOME: "/home/u/.config",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-test",
  RANDOM_SECRET: "nope",
  GITHUB_TOKEN: "ghp_nope",
  AWS_SOME_OTHER: "nope",
  TERM: "xterm-256color",
};

test("only allowlisted vars are forwarded", () => {
  const env = buildChildEnv({ parentEnv: BASE });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.XDG_CONFIG_HOME, "/home/u/.config");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-test");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-test");
  assert.equal(env.RANDOM_SECRET, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AWS_SOME_OTHER, undefined);
});

test("terminal behavior and depth are always pinned", () => {
  const env = buildChildEnv({ parentEnv: BASE });
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.TERM, "dumb");
  assert.equal(env.CLAUDECODE_MCP_DEPTH, "1");
  const nested = buildChildEnv({ parentEnv: { ...BASE, CLAUDECODE_MCP_DEPTH: "1" } });
  assert.equal(nested.CLAUDECODE_MCP_DEPTH, "2");
});

test("host session markers are never forwarded, even when asked", () => {
  const host = {
    ...BASE,
    CLAUDECODE: "1",
    CLAUDE_AUTO_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SESSION_ID: "abc",
    CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID: "x",
    CLAUDE_CODE_REMOTE_SESSION_ID: "y",
    CLAUDE_EFFORT: "high",
    CLAUDECODE_MCP_FORWARD_DANGEROUS: "1",
    CLAUDECODE_MCP_EXTRA_ENV: "CLAUDECODE,CLAUDE_AUTO_BACKGROUND_TASKS,CLAUDE_CODE_SESSION_ID",
  };
  const env = buildChildEnv({
    parentEnv: host,
    profileEnv: { CLAUDECODE: "1", CLAUDE_AUTO_BACKGROUND_TASKS: "1", CLAUDECODE_MCP_DEPTH: "0" },
  });
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_AUTO_BACKGROUND_TASKS",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID",
    "CLAUDE_CODE_REMOTE_SESSION_ID",
    "CLAUDE_EFFORT",
  ]) {
    assert.equal(env[key], undefined, key);
  }
  assert.equal(env.CLAUDECODE_MCP_DEPTH, "1");
});

test("dangerous vars need CLAUDECODE_MCP_FORWARD_DANGEROUS=1", () => {
  const parent = { ...BASE, CLAUDE_CODE_SHELL_PREFIX: "x", ANTHROPIC_CUSTOM_HEADERS: "h" };
  const blocked = buildChildEnv({ parentEnv: parent });
  assert.equal(blocked.CLAUDE_CODE_SHELL_PREFIX, undefined);
  assert.equal(blocked.ANTHROPIC_CUSTOM_HEADERS, undefined);
  const forwarded = buildChildEnv({
    parentEnv: { ...parent, CLAUDECODE_MCP_FORWARD_DANGEROUS: "1" },
  });
  assert.equal(forwarded.CLAUDE_CODE_SHELL_PREFIX, "x");
  assert.equal(forwarded.ANTHROPIC_CUSTOM_HEADERS, "h");
});

test("CLAUDECODE_MCP_EXTRA_ENV forwards named vars", () => {
  const env = buildChildEnv({
    parentEnv: { ...BASE, CLAUDECODE_MCP_EXTRA_ENV: " GITHUB_TOKEN , ,MISSING" },
  });
  assert.equal(env.GITHUB_TOKEN, "ghp_nope");
  assert.equal(env.MISSING, undefined);
});

test("profile env is applied on top of the filtered env", () => {
  const env = buildChildEnv({
    parentEnv: BASE,
    profileEnv: { MY_TOOL_HOME: "/opt/tool", LANG: "C.UTF-8" },
  });
  assert.equal(env.MY_TOOL_HOME, "/opt/tool");
  assert.equal(env.LANG, "C.UTF-8");
});

test("the result has a null prototype", () => {
  const env = buildChildEnv({ parentEnv: BASE });
  assert.equal(Object.getPrototypeOf(env), null);
});

test("isNeverForwarded covers exact names and prefixes", () => {
  assert.equal(isNeverForwarded("CLAUDECODE"), true);
  assert.equal(isNeverForwarded("CLAUDE_CODE_BRIDGE_MCP_CARRIER"), true);
  assert.equal(isNeverForwarded("CLAUDECODE_MCP_DEPTH"), true);
  assert.equal(isNeverForwarded("CLAUDE_CODE_OAUTH_TOKEN"), false);
});
