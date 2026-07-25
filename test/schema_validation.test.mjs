// MCP tool-input schema validation: each tool's runtime input validator
// must reject missing required fields and wrong types.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateInput,
  validateInputWithContext,
  validateInputStructured,
  validateAgainstSchema,
} from "../dist/server.js";

// ----- claude_prompt -----

test("validateInput rejects non-object arguments", () => {
  assert.throws(() => validateInput(null), /must be an object/);
  assert.throws(() => validateInput("hi"), /must be an object/);
  assert.throws(() => validateInput(42), /must be an object/);
});

test("validateInput rejects missing prompt", () => {
  assert.throws(() => validateInput({}), /`prompt` must be a non-empty string/);
});

test("validateInput rejects empty prompt", () => {
  assert.throws(() => validateInput({ prompt: "" }), /`prompt` must be a non-empty string/);
});

test("validateInput rejects wrong-type prompt", () => {
  assert.throws(() => validateInput({ prompt: 123 }), /`prompt` must be a non-empty string/);
});

test("validateInput rejects wrong-type model and system_prompt", () => {
  assert.throws(() => validateInput({ prompt: "p", model: 5 }), /`model` must be a string/);
  assert.throws(
    () => validateInput({ prompt: "p", system_prompt: {} }),
    /`system_prompt` must be a string/,
  );
});

test("validateInput accepts a well-formed payload", () => {
  const out = validateInput({
    prompt: "hi",
    model: "haiku",
    system_prompt: "be terse",
  });
  assert.equal(out.prompt, "hi");
  assert.equal(out.model, "haiku");
  assert.equal(out.system_prompt, "be terse");
});

// ----- claude_prompt_with_context -----

test("validateInputWithContext rejects wrong-type context", () => {
  assert.throws(
    () => validateInputWithContext({ prompt: "p", context: 123 }),
    /`context` must be a string/,
  );
});

test("validateInputWithContext rejects non-array files", () => {
  assert.throws(
    () => validateInputWithContext({ prompt: "p", files: "not-an-array" }),
    /`files` must be an array of strings/,
  );
});

test("validateInputWithContext rejects files containing non-strings", () => {
  assert.throws(
    () => validateInputWithContext({ prompt: "p", files: ["ok.txt", 5] }),
    /`files` must be an array of non-empty strings/,
  );
});

test("validateInputWithContext rejects files containing empty strings", () => {
  assert.throws(
    () => validateInputWithContext({ prompt: "p", files: [""] }),
    /`files` must be an array of non-empty strings/,
  );
});

test("validateInputWithContext accepts a well-formed payload", () => {
  const out = validateInputWithContext({
    prompt: "p",
    context: "ctx",
    files: ["a.txt", "b.txt"],
  });
  assert.equal(out.prompt, "p");
  assert.equal(out.context, "ctx");
  assert.deepEqual(out.files, ["a.txt", "b.txt"]);
});

// ----- claude_prompt_structured -----

test("validateInputStructured rejects non-object schema", () => {
  assert.throws(
    () => validateInputStructured({ prompt: "p", schema: "not-an-object" }),
    /`schema` must be a JSON Schema object/,
  );
  assert.throws(
    () => validateInputStructured({ prompt: "p", schema: [] }),
    /`schema` must be a JSON Schema object/,
  );
});

test("validateInputStructured accepts an object schema", () => {
  const out = validateInputStructured({
    prompt: "p",
    schema: { type: "object", required: ["name"] },
  });
  assert.equal(out.prompt, "p");
  assert.deepEqual(out.schema, { type: "object", required: ["name"] });
});

test("validateInputStructured still enforces base validation (missing prompt)", () => {
  assert.throws(
    () => validateInputStructured({ schema: { type: "object" } }),
    /`prompt` must be a non-empty string/,
  );
});

// ----- validateAgainstSchema -----

test("validateAgainstSchema enforces top-level type", () => {
  assert.throws(() => validateAgainstSchema("hello", { type: "object" }), /expected type 'object'/);
  assert.throws(() => validateAgainstSchema(42, { type: "string" }), /expected type 'string'/);
  assert.doesNotThrow(() => validateAgainstSchema({ a: 1 }, { type: "object" }));
});

test("validateAgainstSchema enforces per-property type", () => {
  const schema = {
    type: "object",
    properties: { age: { type: "integer" } },
  };
  assert.throws(() => validateAgainstSchema({ age: "old" }, schema), /expected type 'integer'/);
  assert.doesNotThrow(() => validateAgainstSchema({ age: 30 }, schema));
});
