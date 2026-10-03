import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertDepthAllowsTasks,
  childDepth,
  currentDepth,
  DepthLimitError,
  DEPTH_ENV,
} from "../dist/depth.js";

test("depth is 0 when unset or empty", () => {
  assert.equal(currentDepth({}), 0);
  assert.equal(currentDepth({ [DEPTH_ENV]: "" }), 0);
  assert.equal(childDepth({}), "1");
});

test("depth parses plain integers and increments for the child", () => {
  assert.equal(currentDepth({ [DEPTH_ENV]: "2" }), 2);
  assert.equal(childDepth({ [DEPTH_ENV]: "2" }), "3");
});

test("garbled depth markers fail closed as depth 1", () => {
  for (const raw of ["-1", "abc", "1.5", " 0", "9999999"]) {
    assert.equal(currentDepth({ [DEPTH_ENV]: raw }), 1, raw);
  }
});

test("task tools are allowed only at depth 0", () => {
  assert.doesNotThrow(() => assertDepthAllowsTasks({}));
  assert.doesNotThrow(() => assertDepthAllowsTasks({ [DEPTH_ENV]: "0" }));
  assert.throws(() => assertDepthAllowsTasks({ [DEPTH_ENV]: "1" }), DepthLimitError);
  assert.throws(() => assertDepthAllowsTasks({ [DEPTH_ENV]: "junk" }), DepthLimitError);
});
