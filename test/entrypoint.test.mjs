import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../dist/server.js";

const DIST_SERVER = fileURLToPath(new URL("../dist/server.js", import.meta.url));

test("entrypoint detection compares canonical module paths, not basenames", () => {
  const dir = mkdtempSync(join(tmpdir(), "claudecode-mcp-entry-"));
  const unrelated = join(dir, "server.js");
  writeFileSync(unrelated, "// unrelated script with the same basename\n");

  assert.equal(isMainModule(DIST_SERVER), true);
  assert.equal(isMainModule(unrelated), false);
});

test(
  "entrypoint detection accepts a symlink to the package executable",
  { skip: process.platform === "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "claudecode-mcp-bin-"));
    const linked = join(dir, "claudecode-mcp");
    symlinkSync(DIST_SERVER, linked);
    assert.equal(isMainModule(linked), true);
  },
);
