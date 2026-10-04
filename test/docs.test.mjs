// Keep the shipped examples and README honest: they must match the schema.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseConfig } from "../dist/config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("examples/config.example.json is a valid config", () => {
  const c = parseConfig(
    JSON.parse(readFileSync(join(ROOT, "examples", "config.example.json"), "utf8")),
  );
  assert.deepEqual(Object.keys(c.profiles).sort(), [
    "personal",
    "reviewer-clean",
    "worker",
    "worker-github",
  ]);
});

test("every JSON config block in README.md is a valid config", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  const configs = blocks.filter((b) => "profiles" in b || "allowed_roots" in b);
  assert.ok(configs.length >= 1);
  for (const c of configs) assert.doesNotThrow(() => parseConfig(c));
});

test("README lists every MCP tool the server registers", async () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  for (const tool of [
    "start_task",
    "get_task",
    "wait_task",
    "get_events",
    "send_message",
    "get_diff",
    "cancel_task",
    "close_task",
    "list_tasks",
    "ask",
  ]) {
    assert.match(readme, new RegExp("`" + tool + "`"), tool);
  }
});
