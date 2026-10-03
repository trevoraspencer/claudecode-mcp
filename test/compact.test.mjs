import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compactEvent, readEventsPage, recentSteps } from "../dist/compact.js";

function file(lines) {
  const p = join(mkdtempSync(join(tmpdir(), "ccm-compact-")), "events.jsonl");
  writeFileSync(
    p,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
  return p;
}

const text = (t) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });

test("compactEvent covers the main event types", () => {
  assert.deepEqual(
    compactEvent({ type: "system", subtype: "init", model: "m", permissionMode: "auto" }),
    [{ kind: "turn_start", model: "m", permission_mode: "auto" }],
  );
  assert.deepEqual(
    compactEvent({
      type: "assistant",
      message: {
        content: [
          { type: "thinking" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ],
      },
    }),
    [{ kind: "tool", name: "Bash", input: "ls" }],
  );
  assert.deepEqual(
    compactEvent({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] },
    }),
    [{ kind: "tool_error", text: "boom" }],
  );
  assert.equal(
    compactEvent({ type: "result", subtype: "success", result: "x".repeat(600) })[0].text.length <
      600,
    true,
  );
  assert.deepEqual(compactEvent(null), []);
  assert.deepEqual(compactEvent({ type: "stream_event" }), []);
});

test("pages walk the file with byte cursors, including multi-byte text", () => {
  const p = file([text("héllo é"), text("日本語"), text("end")]);
  const a = readEventsPage(p, 0, 2);
  assert.equal(a.events.length, 2);
  assert.equal(a.events[1].steps[0].text, "日本語");
  const b = readEventsPage(p, a.next_cursor, 10);
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].steps[0].text, "end");
  assert.equal(b.eof, true);
  assert.equal(b.events[0].offset, a.next_cursor);
});

test("a cursor inside a line (or a character) moves to the next line", () => {
  const p = file([text("héllo é"), text("second")]);
  const page = readEventsPage(p, 40, 10);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].steps[0].text, "second");
  assert.equal(page.eof, true);
});

test("a cursor past EOF is an empty final page", () => {
  const p = file([text("a")]);
  const page = readEventsPage(p, 10_000, 10);
  assert.deepEqual(page.events, []);
  assert.equal(page.eof, true);
});

test("an oversized line is skipped, not a dead end", () => {
  const p = file([text("before")]);
  appendFileSync(p, JSON.stringify(text("x".repeat(17 * 1024 * 1024))) + "\n");
  appendFileSync(p, JSON.stringify(text("after")) + "\n");
  const first = readEventsPage(p, 0, 1);
  const big = readEventsPage(p, first.next_cursor, 10);
  assert.equal(big.events[0].type, "oversized");
  assert.ok(big.events[0].skipped_bytes > 16 * 1024 * 1024);
  const after = readEventsPage(p, big.next_cursor, 10);
  assert.equal(after.events[0].steps[0].text, "after");
});

test("recentSteps returns the last n steps", () => {
  const p = file([text("a"), "not json", text("b"), text("c")]);
  assert.deepEqual(
    recentSteps(p, 2).map((s) => s.text),
    ["b", "c"],
  );
  assert.deepEqual(recentSteps(join(tmpdir(), "missing-events.jsonl"), 2), []);
});
