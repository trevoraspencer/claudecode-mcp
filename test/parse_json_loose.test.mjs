// Tests for parseJsonLoose: fast path, bounded balanced-bracket recovery,
// diagnostic disambiguation, and the empty-input case.

import { test } from "node:test";
import assert from "node:assert/strict";

const { parseJsonLoose } = await import("../dist/invoke.js");

test("fast path: plain JSON object parses", () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
});

test("fast path: plain JSON array parses", () => {
  assert.deepEqual(parseJsonLoose("[1,2,3]"), [1, 2, 3]);
});

test("whitespace around valid JSON is fine", () => {
  assert.deepEqual(parseJsonLoose('  {"a":1}\n'), { a: 1 });
});

test("recovery: ignores leading log lines and parses a JSON line", () => {
  const stdout = '[debug] starting up\nsome warning\n{"result":"ok"}\n';
  assert.deepEqual(parseJsonLoose(stdout), { result: "ok" });
});

test("balanced-bracket: extracts a JSON object embedded in noise", () => {
  const stdout = 'noise before {"a":{"b":2}} trailing junk';
  assert.deepEqual(parseJsonLoose(stdout), { a: { b: 2 } });
});

test("balanced-bracket: picks the longest balanced region", () => {
  // Two balanced regions: {"x":1} and {"y":2,"z":{"w":3}}. The second is
  // longer, so it should win.
  const stdout = '{"x":1}\n--- separator ---\n{"y":2,"z":{"w":3}}';
  assert.deepEqual(parseJsonLoose(stdout), { y: 2, z: { w: 3 } });
});

test("recovery prefers a Claude payload over valid JSON diagnostics", () => {
  const stdout = [
    '{"level":"debug","message":"starting"}',
    '["another valid diagnostic"]',
    '{"result":"actual response"}',
  ].join("\n");
  assert.deepEqual(parseJsonLoose(stdout), { result: "actual response" });
});

test("an unmatched diagnostic bracket cannot poison a later standalone response", () => {
  const stdout = 'diagnostic left an unmatched {\n{"result":"recovered"}\n';
  assert.deepEqual(parseJsonLoose(stdout), { result: "recovered" });
});

test("balanced-bracket: string contents with quoted braces don't confuse it", () => {
  const stdout = 'pre {"msg":"x { y } z"} post';
  assert.deepEqual(parseJsonLoose(stdout), { msg: "x { y } z" });
});

test("balanced-bracket: escaped quotes inside strings don't terminate early", () => {
  const stdout = 'noise {"msg":"a \\"quoted\\" b"} more noise';
  assert.deepEqual(parseJsonLoose(stdout), { msg: 'a "quoted" b' });
});

test("empty input throws", () => {
  assert.throws(() => parseJsonLoose(""), /empty stdout/);
  assert.throws(() => parseJsonLoose("   \n\t  "), /empty stdout/);
});

test("totally unparseable input throws", () => {
  assert.throws(
    () => parseJsonLoose("just plain text with no brackets at all"),
    /failed to parse JSON/,
  );
});

test("parse errors do not echo a raw stdout prefix", () => {
  const raw = "sensitive-arbitrary-value that is not JSON";
  assert.throws(
    () => parseJsonLoose(raw),
    (err) => err instanceof Error && !err.message.includes("sensitive-arbitrary-value"),
  );
});

test("mismatched brackets do not yield a bogus parse", () => {
  // No balanced region; nothing should parse.
  assert.throws(() => parseJsonLoose("garbage [ noise } valid"), /failed to parse JSON/);
});

test("fallback scan bounds adversarial nesting and candidate counts", () => {
  assert.throws(
    () => parseJsonLoose(`${"[".repeat(1025)}noise${"]".repeat(1025)}`),
    /nesting exceeds 1024/,
  );
  assert.throws(() => parseJsonLoose("{}\n".repeat(1001)), /candidate count exceeds 1000/);
});
