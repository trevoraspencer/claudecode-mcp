import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigError,
  loadConfig,
  parseConfig,
  resolveProfile,
  UnknownProfileError,
} from "../dist/config.js";

function writeConfig(value) {
  const dir = mkdtempSync(join(tmpdir(), "claudecode-mcp-config-"));
  const path = join(dir, "config.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

test("a missing config file gives built-in defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "claudecode-mcp-config-"));
  const loaded = loadConfig({ CLAUDECODE_MCP_CONFIG: join(dir, "absent.json") });
  assert.equal(loaded.source, "defaults");
  const c = loaded.config;
  assert.deepEqual(c.allowed_roots, [homedir()]);
  assert.equal(c.max_concurrent, 3);
  assert.equal(c.max_minutes, 120);
  assert.equal(c.stall_minutes, 10);
  assert.equal(c.stale_days, 7);
  assert.equal(c.idle_minutes, 15);
  assert.equal(c.max_events_mb, 100);
  assert.equal(c.default_profile, "worker");
  assert.deepEqual(Object.keys(c.profiles), ["worker"]);
  const w = c.profiles.worker;
  assert.equal(w.permission_mode, "auto");
  assert.deepEqual(w.setting_sources, ["project", "local"]);
  assert.deepEqual(w.mcp_servers, {});
  assert.equal(w.inherit_user_mcp, false);
  assert.deepEqual(w.personal_hooks, []);
  assert.deepEqual(w.personal_skills, []);
  assert.equal(w.skills, true);
  assert.deepEqual(w.env, {});
});

test("XDG_CONFIG_HOME locates the file when no override is set", () => {
  const xdg = mkdtempSync(join(tmpdir(), "claudecode-mcp-xdg-"));
  mkdirSync(join(xdg, "claudecode-mcp"));
  writeFileSync(join(xdg, "claudecode-mcp", "config.json"), JSON.stringify({ max_concurrent: 5 }));
  const loaded = loadConfig({ XDG_CONFIG_HOME: xdg });
  assert.equal(loaded.source, "file");
  assert.equal(loaded.config.max_concurrent, 5);
});

test("the design-doc example config is valid", () => {
  const path = writeConfig({
    allowed_roots: ["~/code"],
    max_concurrent: 3,
    max_minutes: 120,
    stall_minutes: 10,
    default_profile: "worker",
    profiles: {
      worker: {
        permission_mode: "auto",
        setting_sources: ["project", "local"],
        mcp_servers: {},
        personal_hooks: ["PostToolUse:0"],
        personal_skills: ["commit-style", "test-runner"],
      },
      "worker-github": {
        permission_mode: "auto",
        setting_sources: ["project", "local"],
        mcp_servers: { github: { command: "github-mcp-server", args: ["stdio"] } },
      },
      "reviewer-clean": {
        permission_mode: "auto",
        setting_sources: ["project"],
        mcp_servers: {},
        skills: false,
      },
      personal: {
        permission_mode: "bypassPermissions",
        setting_sources: ["user", "project", "local"],
        inherit_user_mcp: true,
      },
    },
  });
  const { config, source } = loadConfig({ CLAUDECODE_MCP_CONFIG: path });
  assert.equal(source, "file");
  assert.deepEqual(config.allowed_roots, [join(homedir(), "code")]);
  assert.deepEqual(Object.keys(config.profiles).sort(), [
    "personal",
    "reviewer-clean",
    "worker",
    "worker-github",
  ]);
  assert.equal(config.profiles.personal.permission_mode, "bypassPermissions");
  assert.equal(config.profiles["reviewer-clean"].skills, false);
  assert.equal(config.profiles["worker-github"].mcp_servers.github.command, "github-mcp-server");
});

test("unknown keys fail, top level and in profiles", () => {
  assert.throws(() => parseConfig({ max_concurent: 3 }), ConfigError);
  assert.throws(
    () => parseConfig({ profiles: { worker: { permision_mode: "auto" } } }),
    (err) => err instanceof ConfigError && /permision_mode/.test(err.message),
  );
});

test("invalid values fail with the config path in the message", () => {
  const path = writeConfig({ max_concurrent: 0 });
  assert.throws(
    () => loadConfig({ CLAUDECODE_MCP_CONFIG: path }),
    (err) => err instanceof ConfigError && err.message.includes(path),
  );
});

test("bad JSON fails clearly", () => {
  const path = writeConfig("{ not json");
  assert.throws(
    () => loadConfig({ CLAUDECODE_MCP_CONFIG: path }),
    (err) => err instanceof ConfigError && /not valid JSON/.test(err.message),
  );
});

test("a directory at the config path fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "claudecode-mcp-config-"));
  assert.throws(() => loadConfig({ CLAUDECODE_MCP_CONFIG: dir }), /not a regular file/);
});

test("rejects bad numbers, modes, and cross-field limits", () => {
  for (const bad of [
    { max_concurrent: 1.5 },
    { max_concurrent: 17 },
    { max_minutes: 0 },
    { idle_minutes: 0 },
    { max_events_mb: 0 },
    { stall_minutes: 120, max_minutes: 120 },
    { profiles: { worker: { permission_mode: "default" } } },
    { profiles: { worker: { setting_sources: ["user", "user"] } } },
    { profiles: { worker: { setting_sources: ["global"] } } },
    { profiles: { worker: { effort: "ultra" } } },
    { profiles: { worker: { model: "bad model" } } },
  ]) {
    assert.throws(() => parseConfig(bad), ConfigError, JSON.stringify(bad));
  }
});

test("default_profile must name a defined profile", () => {
  assert.throws(
    () => parseConfig({ profiles: { reviewer: {} } }),
    (err) => err instanceof ConfigError && /default_profile/.test(err.message),
  );
  const c = parseConfig({ default_profile: "reviewer", profiles: { reviewer: {} } });
  assert.deepEqual(Object.keys(c.profiles), ["reviewer"]);
});

test("paths must be absolute or ~/ and are normalized", () => {
  const c = parseConfig({
    allowed_roots: ["/srv/code/../repos", "~"],
    profiles: { worker: { plugin_dirs: ["~/plugins/a"], config_dir: "/opt/claude-home/" } },
  });
  assert.deepEqual(c.allowed_roots, ["/srv/repos", homedir()]);
  assert.deepEqual(c.profiles.worker.plugin_dirs, [join(homedir(), "plugins", "a")]);
  assert.equal(c.profiles.worker.config_dir, "/opt/claude-home");
  assert.throws(() => parseConfig({ allowed_roots: ["code"] }), ConfigError);
  assert.throws(() => parseConfig({ allowed_roots: ["~other/code"] }), ConfigError);
  assert.throws(() => parseConfig({ allowed_roots: ["/a\nb"] }), ConfigError);
});

test("settings accepts a path or an inline object", () => {
  const a = parseConfig({ profiles: { worker: { settings: "~/s.json" } } });
  assert.equal(a.profiles.worker.settings, join(homedir(), "s.json"));
  const b = parseConfig({ profiles: { worker: { settings: { autoMode: {} } } } });
  assert.deepEqual(b.profiles.worker.settings, { autoMode: {} });
});

test("profile env may not set reserved variables", () => {
  for (const key of ["CLAUDECODE", "CLAUDE_AUTO_BACKGROUND_TASKS", "CLAUDECODE_MCP_DEPTH"]) {
    assert.throws(
      () => parseConfig({ profiles: { worker: { env: { [key]: "1" } } } }),
      ConfigError,
      key,
    );
  }
  assert.throws(() => parseConfig({ profiles: { worker: { env: { "BAD-NAME": "1" } } } }));
  const c = parseConfig({ profiles: { worker: { env: { MY_VAR: "x" } } } });
  assert.deepEqual(c.profiles.worker.env, { MY_VAR: "x" });
});

test("this server can never be given to its own tasks", () => {
  for (const servers of [
    { "claudecode-mcp": { command: "node" } },
    { self: { command: "/usr/local/bin/claudecode-mcp" } },
    { self: { command: "npx", args: ["-y", "claudecode-mcp"] } },
  ]) {
    assert.throws(
      () => parseConfig({ profiles: { worker: { mcp_servers: servers } } }),
      ConfigError,
      JSON.stringify(servers),
    );
  }
});

test("MCP server entries need a command or url and keep extra fields", () => {
  assert.throws(() => parseConfig({ profiles: { worker: { mcp_servers: { x: {} } } } }));
  const c = parseConfig({
    profiles: {
      worker: {
        mcp_servers: { remote: { type: "http", url: "https://x.test/mcp", headers: { a: "b" } } },
      },
    },
  });
  assert.deepEqual(c.profiles.worker.mcp_servers.remote.headers, { a: "b" });
});

test("personal hook and skill names are checked", () => {
  assert.throws(() => parseConfig({ profiles: { worker: { personal_hooks: ["nocolon"] } } }));
  assert.throws(() => parseConfig({ profiles: { worker: { personal_hooks: ["Stop:name"] } } }));
  assert.throws(() => parseConfig({ profiles: { worker: { personal_skills: ["../evil"] } } }));
  assert.throws(() => parseConfig({ profiles: { worker: { personal_skills: ["a/b"] } } }));
  const c = parseConfig({
    profiles: { worker: { personal_hooks: ["Stop:0"], personal_skills: ["commit-style"] } },
  });
  assert.deepEqual(c.profiles.worker.personal_hooks, ["Stop:0"]);
});

test("resolveProfile picks the default or a named profile", () => {
  const c = parseConfig({ profiles: { worker: {}, reviewer: { skills: false } } });
  assert.equal(resolveProfile(c).name, "worker");
  assert.equal(resolveProfile(c, "reviewer").profile.skills, false);
  assert.throws(() => resolveProfile(c, "nope"), UnknownProfileError);
  assert.throws(() => resolveProfile(c, "__proto__"), UnknownProfileError);
});

test("$schema is allowed for editor support and dropped", () => {
  const c = parseConfig({ $schema: "https://example.test/schema.json" });
  assert.equal("$schema" in c, false);
});

test("inline settings may not set reserved variables in env", () => {
  for (const key of ["CLAUDECODE_MCP_DEPTH", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID"]) {
    assert.throws(
      () => parseConfig({ profiles: { worker: { settings: { env: { [key]: "0" } } } } }),
      ConfigError,
      key,
    );
  }
  assert.doesNotThrow(() =>
    parseConfig({ profiles: { worker: { settings: { env: { FOO: "1" } } } } }),
  );
});

test("http block: defaults, loopback-only host, path and host checks", () => {
  const d = parseConfig({}).http;
  assert.deepEqual(d, {
    host: "127.0.0.1",
    port: 8787,
    path: "/mcp",
    allowed_hosts: [],
    allowed_origins: [],
  });
  const c = parseConfig({
    http: { port: 0, path: "/api/mcp", allowed_hosts: ["VM.Tail1234.ts.net."] },
  }).http;
  assert.equal(c.port, 0);
  assert.equal(c.path, "/api/mcp");
  assert.deepEqual(c.allowed_hosts, ["vm.tail1234.ts.net"]);
  for (const bad of [
    { host: "0.0.0.0" },
    { host: "100.64.0.1" },
    { port: 70000 },
    { path: "mcp" },
    { path: "/healthz" },
    { path: "/a/../b" },
    { allowed_hosts: ["evil.com:443"] },
    { allowed_hosts: ["a b"] },
    { allowed_origins: ["https://x.example/path"] },
    { tokens_file: "relative.json" },
    { bogus: 1 },
  ]) {
    assert.throws(() => parseConfig({ http: bad }), ConfigError, JSON.stringify(bad));
  }
});
