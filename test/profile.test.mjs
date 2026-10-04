import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "../dist/config.js";
import {
  assertProfilesValid,
  describePersonalConfig,
  materializeProfile,
  personalSkills,
  ProfileError,
  profileProblems,
} from "../dist/profile.js";

/** A fake personal Claude home with two hooks and two skills. */
function home() {
  const dir = mkdtempSync(join(tmpdir(), "ccm-home-"));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt.sh" }] }],
        Stop: [{ hooks: [{ type: "command", command: "notify.sh" }] }],
      },
    }),
  );
  for (const s of ["commit-style", "test-runner"]) {
    mkdirSync(join(dir, "skills", s), { recursive: true });
    writeFileSync(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  }
  mkdirSync(join(dir, "skills", "not-a-skill"));
  return { dir, env: { CLAUDE_CONFIG_DIR: dir } };
}

const profile = (p) => parseConfig({ profiles: { worker: p } }).profiles.worker;

test("personal skills are folders with a SKILL.md", () => {
  const h = home();
  assert.deepEqual(personalSkills(h.env), ["commit-style", "test-runner"]);
});

test("profileProblems finds missing hooks, skills, folders, and bad settings", () => {
  const h = home();
  const bad = join(h.dir, "bad.json");
  writeFileSync(bad, "[1]");
  const problems = profileProblems(
    "worker",
    profile({
      personal_hooks: ["PostToolUse:0", "PostToolUse:1", "Nope:0"],
      personal_skills: ["commit-style", "missing-skill", "not-a-skill"],
      plugin_dirs: [join(h.dir, "no-plugin")],
      settings: bad,
      config_dir: join(h.dir, "no-home"),
    }),
    h.env,
  );
  const text = problems.join("\n");
  assert.match(text, /PostToolUse:1" not found/);
  assert.match(text, /missing-skill" not found/);
  assert.match(text, /not-a-skill" not found/);
  assert.match(text, /plugin dir not found/);
  assert.match(text, /settings file is not a JSON object/);
  assert.match(text, /config_dir not found/);
  assert.doesNotMatch(text, /commit-style/);
});

test("assertProfilesValid passes clean configs and lists every problem", () => {
  const h = home();
  assert.doesNotThrow(() => assertProfilesValid(parseConfig({}), h.env));
  assert.throws(
    () =>
      assertProfilesValid(
        parseConfig({ profiles: { a: { personal_skills: ["x"] }, worker: {} } }),
        h.env,
      ),
    (err) => err instanceof ProfileError && /profile "a"/.test(err.message),
  );
});

test("materialize: inline settings plus picked hooks become one settings file", () => {
  const h = home();
  const taskDir = mkdtempSync(join(tmpdir(), "ccm-task-"));
  const m = materializeProfile(
    "worker",
    profile({
      settings: {
        hooks: { Stop: [{ hooks: [{ type: "command", command: "own.sh" }] }] },
        env: { A: "1" },
      },
      personal_hooks: ["Stop:0", "PostToolUse:0"],
    }),
    taskDir,
    h.env,
  );
  const settings = JSON.parse(readFileSync(m.settings_file, "utf8"));
  assert.equal(m.settings_file, join(taskDir, "settings.json"));
  assert.deepEqual(settings.env, { A: "1" });
  assert.deepEqual(
    settings.hooks.Stop.map((e) => e.hooks[0].command),
    ["own.sh", "notify.sh"],
  );
  assert.equal(settings.hooks.PostToolUse[0].matcher, "Edit");
  assert.equal(m.personal_plugin_dir, undefined);
});

test("materialize: a settings path with no hooks is passed through; nothing at all gives nothing", () => {
  const h = home();
  const taskDir = mkdtempSync(join(tmpdir(), "ccm-task-"));
  const path = join(h.dir, "s.json");
  writeFileSync(path, "{}");
  assert.deepEqual(materializeProfile("worker", profile({ settings: path }), taskDir, h.env), {
    settings_file: path,
  });
  assert.deepEqual(materializeProfile("worker", profile({}), taskDir, h.env), {});
});

test("materialize: personal skills become a plugin of symlinks", () => {
  const h = home();
  const taskDir = mkdtempSync(join(tmpdir(), "ccm-task-"));
  const m = materializeProfile(
    "worker",
    profile({ personal_skills: ["commit-style"] }),
    taskDir,
    h.env,
  );
  const link = join(m.personal_plugin_dir, "skills", "commit-style");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), join(h.dir, "skills", "commit-style"));
  const manifest = JSON.parse(
    readFileSync(join(m.personal_plugin_dir, ".claude-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(manifest.name, "claudecode-personal");
  // Idempotent for a resumed task.
  materializeProfile("worker", profile({ personal_skills: ["commit-style"] }), taskDir, h.env);
});

test("materialize refuses broken references", () => {
  const h = home();
  const taskDir = mkdtempSync(join(tmpdir(), "ccm-task-"));
  assert.throws(
    () => materializeProfile("worker", profile({ personal_hooks: ["Stop:5"] }), taskDir, h.env),
    ProfileError,
  );
  assert.equal(existsSync(join(taskDir, "settings.json")), false);
});

test("describePersonalConfig lists hooks with indexes and skills", () => {
  const h = home();
  const text = describePersonalConfig(h.env);
  assert.match(text, /PostToolUse:0 matcher=Edit {2}fmt\.sh/);
  assert.match(text, /Stop:0 {2}notify\.sh/);
  assert.match(text, /^ {2}commit-style$/m);
  const empty = describePersonalConfig({
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "ccm-empty-")),
  });
  assert.match(empty, /Hooks[^\n]*\n {2}\(none\)/);
});

test("settings files and user settings may not set reserved env either", () => {
  const h = home();
  const file = join(h.dir, "s.json");
  writeFileSync(file, JSON.stringify({ env: { CLAUDECODE_MCP_DEPTH: "0" } }));
  const fromFile = profileProblems("worker", profile({ settings: file }), h.env).join("\n");
  assert.match(fromFile, /sets reserved environment variables in "env": CLAUDECODE_MCP_DEPTH/);

  writeFileSync(join(h.dir, "settings.json"), JSON.stringify({ env: { CLAUDECODE: "1" } }));
  const userSrc = profileProblems(
    "worker",
    profile({ setting_sources: ["user", "project"] }),
    h.env,
  ).join("\n");
  assert.match(userSrc, /settings\.json sets reserved environment variables in "env": CLAUDECODE/);
  assert.deepEqual(
    profileProblems("worker", profile({}), h.env),
    [],
    "user settings ignored without the user source",
  );
});
