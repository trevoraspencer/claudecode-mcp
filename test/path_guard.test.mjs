// Path-guard tests: safeResolveUnderCwd must reject absolute paths, ../
// escapes, symlinks pointing outside cwd, missing files, non-files, and
// oversized files. Resolves to a real path under cwd otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { safeResolveUnderCwd } = await import("../dist/path-guard.js");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "claudecode-mcp-pg-"));
  const inside = join(root, "inside.txt");
  writeFileSync(inside, "hello");
  mkdirSync(join(root, "sub"));
  const subFile = join(root, "sub", "nested.txt");
  writeFileSync(subFile, "nested");
  const outside = mkdtempSync(join(tmpdir(), "claudecode-mcp-pg-outside-"));
  const outsideFile = join(outside, "secret.txt");
  writeFileSync(outsideFile, "secret");
  return { root, outside, outsideFile };
}

test("resolves a normal relative path under cwd", async () => {
  const { root } = setup();
  const resolved = await safeResolveUnderCwd("inside.txt", root);
  assert.ok(resolved.endsWith("inside.txt"));
});

test("resolves a nested relative path", async () => {
  const { root } = setup();
  const resolved = await safeResolveUnderCwd("sub/nested.txt", root);
  assert.ok(resolved.endsWith("sub/nested.txt") || resolved.endsWith("sub\\nested.txt"));
});

test("rejects absolute paths", async () => {
  const { root } = setup();
  await assert.rejects(() => safeResolveUnderCwd("/etc/passwd", root), /must be relative/);
});

test("rejects ../ escape outside cwd", async () => {
  const { root, outsideFile } = setup();
  // Construct a relative path that escapes the root.
  const rel = `../${outsideFile.split("/").pop()}`;
  await assert.rejects(
    () => safeResolveUnderCwd(`../../../../../../etc/passwd`, root),
    /escapes working directory|not found/,
  );
  // And a relative path that escapes the temp root specifically.
  await assert.rejects(
    () => safeResolveUnderCwd(`../${outsideFile.split("/").slice(-2).join("/")}`, root),
    /escapes working directory|not found/,
  );
});

test("rejects symlinks pointing outside cwd", async () => {
  const { root, outsideFile } = setup();
  const linkPath = join(root, "evil.txt");
  symlinkSync(outsideFile, linkPath);
  await assert.rejects(
    () => safeResolveUnderCwd("evil.txt", root),
    /outside working directory via symlink/,
  );
});

test("rejects files exceeding the size cap", async () => {
  const { root } = setup();
  const big = join(root, "big.txt");
  writeFileSync(big, "x".repeat(2048));
  process.env.CLAUDECODE_MCP_MAX_FILE_BYTES = "1024";
  try {
    await assert.rejects(() => safeResolveUnderCwd("big.txt", root), /exceeds 1024 bytes/);
  } finally {
    delete process.env.CLAUDECODE_MCP_MAX_FILE_BYTES;
  }
});

test("rejects missing files with a clear error", async () => {
  const { root } = setup();
  await assert.rejects(() => safeResolveUnderCwd("does-not-exist.txt", root), /file not found/);
});

test("rejects directories (not regular files)", async () => {
  const { root } = setup();
  await assert.rejects(() => safeResolveUnderCwd("sub", root), /not a regular file/);
});
