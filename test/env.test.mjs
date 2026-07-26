import { test } from "node:test";
import assert from "node:assert/strict";

import { numFromEnv } from "../dist/env.js";

test("numFromEnv accepts only positive safe integers within the caller's bound", () => {
  const key = "CLAUDECODE_MCP_TEST_NUMBER";
  try {
    for (const invalid of ["0", "-1", "1.5", "1e3", "Infinity", "9007199254740992"]) {
      process.env[key] = invalid;
      assert.equal(numFromEnv(key, 42), 42, `${invalid} should use the fallback`);
    }

    process.env[key] = "101";
    assert.equal(numFromEnv(key, 42, 100), 42);
    process.env[key] = "100";
    assert.equal(numFromEnv(key, 42, 100), 100);
  } finally {
    delete process.env[key];
  }
});
