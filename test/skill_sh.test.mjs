import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, "..", "skill.sh");

function setupFakeClaude() {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-skill-"));
  const bin = join(root, "bin");
  const argvFile = join(root, "argv.json");
  const envFile = join(root, "env.json");
  const stdinFile = join(root, "stdin.txt");
  const fake = join(bin, "claude");
  mkdirSync(bin);
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CLAUDECODE_MCP_TEST_ARGV, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(process.env.CLAUDECODE_MCP_TEST_ENV, JSON.stringify(process.env));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.CLAUDECODE_MCP_TEST_STDIN, input);
});
`,
  );
  chmodSync(fake, 0o755);
  return { root, bin, argvFile, envFile, stdinFile };
}

function runSkill(setup, args, input = "", overrides = {}) {
  return spawnSync("bash", [SKILL, ...args], {
    cwd: setup.root,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${setup.bin}:${process.env.PATH}`,
      CLAUDECODE_MCP_TEST_ARGV: setup.argvFile,
      CLAUDECODE_MCP_TEST_ENV: setup.envFile,
      CLAUDECODE_MCP_TEST_STDIN: setup.stdinFile,
      CLAUDE_CODE_SHELL_PREFIX: "must-not-reach-child",
      NODE_OPTIONS: "--trace-warnings",
      UNRELATED_AMBIENT_VALUE: "must-not-reach-child",
      MY_SKILL_EXTRA: "explicit-extra",
      CLAUDECODE_MCP_EXTRA_ENV: " MY_SKILL_EXTRA , ",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_SECRET_ACCESS_KEY: "provider-secret",
      ...overrides,
    },
  });
}

test(
  "skill.sh preserves argv boundaries and filters the child environment",
  { skip: process.platform === "win32" },
  () => {
    const setup = setupFakeClaude();
    const result = runSkill(setup, ["--resume", setup.root]);
    assert.equal(result.status, 0, result.stderr);

    const argv = JSON.parse(readFileSync(setup.argvFile, "utf8"));
    assert.deepEqual(argv.slice(-2), ["--", "--resume"]);
    const childEnv = JSON.parse(readFileSync(setup.envFile, "utf8"));
    assert.equal(childEnv.CLAUDE_CODE_SHELL_PREFIX, undefined);
    assert.equal(childEnv.NODE_OPTIONS, undefined);
    assert.equal(childEnv.UNRELATED_AMBIENT_VALUE, undefined);
    assert.equal(childEnv.MY_SKILL_EXTRA, "explicit-extra");
    assert.equal(childEnv.CLAUDE_CODE_USE_BEDROCK, "1");
    assert.equal(childEnv.AWS_REGION, "us-east-1");
    assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, "provider-secret");
    assert.equal(childEnv.NO_COLOR, "1");
    assert.equal(childEnv.TERM, "dumb");
  },
);

test(
  "skill.sh honors dangerous forwarding and bare mode without a second escape hatch",
  { skip: process.platform === "win32" },
  () => {
    const setup = setupFakeClaude();
    const result = runSkill(setup, ["prompt", setup.root], "", {
      CLAUDECODE_MCP_FORWARD_DANGEROUS: "1",
      CLAUDECODE_MCP_EXTRA_ENV: "",
      CLAUDECODE_MCP_BARE: "1",
    });
    assert.equal(result.status, 0, result.stderr);

    const argv = JSON.parse(readFileSync(setup.argvFile, "utf8"));
    assert.ok(argv.includes("--bare"));
    assert.ok(!argv.includes("--strict-mcp-config"));
    const childEnv = JSON.parse(readFileSync(setup.envFile, "utf8"));
    assert.equal(childEnv.CLAUDE_CODE_SHELL_PREFIX, "must-not-reach-child");
  },
);

test(
  "skill.sh stdin mode supports prompts larger than one argv element",
  { skip: process.platform === "win32" },
  () => {
    const setup = setupFakeClaude();
    const prompt = "large prompt\n" + "x".repeat(200 * 1024);
    const result = runSkill(setup, ["-", setup.root], prompt);
    assert.equal(result.status, 0, result.stderr);

    const argv = JSON.parse(readFileSync(setup.argvFile, "utf8"));
    assert.ok(!argv.includes("--"), "stdin mode must not add a positional prompt separator");
    assert.equal(readFileSync(setup.stdinFile, "utf8"), prompt);
  },
);
