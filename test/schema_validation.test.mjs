// MCP tool-input schema validation: each tool's runtime input validator
// must reject missing required fields and wrong types.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateInput,
  validateInputWithContext,
  validateInputStructured,
  validateAgainstSchema,
  serializeSchemaForCli,
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

test("runtime validators enforce the advertised additionalProperties: false contract", () => {
  assert.throws(() => validateInput({ prompt: "p", typo: true }), /unknown argument: typo/);
  assert.throws(
    () => validateInputWithContext({ prompt: "p", files: [], working_dir: "/tmp" }),
    /unknown argument: working_dir/,
  );
  assert.throws(
    () => validateInputStructured({ prompt: "p", schema: {}, session_id: "resume-me" }),
    /unknown argument: session_id/,
  );
});

test("validateInput rejects unsafe or unbounded argv-backed options", () => {
  assert.throws(() => validateInput({ prompt: "p", model: "--resume" }), /begins with '-'/);
  assert.throws(() => validateInput({ prompt: "p", model: "bad model" }), /whitespace/);
  assert.throws(
    () => validateInput({ prompt: "p", system_prompt: "x".repeat(100 * 1024 + 1) }),
    /system_prompt.*exceeds/,
  );
  assert.throws(
    () => validateInput({ prompt: "p", system_prompt: "contains\0nul" }),
    /must not contain NUL/,
  );
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

test("validateInputWithContext bounds the number of files", () => {
  assert.throws(
    () =>
      validateInputWithContext({
        prompt: "p",
        files: Array.from({ length: 33 }, (_, i) => `file-${i}.txt`),
      }),
    /at most 32 paths/,
  );
});

test("file-count bounds run before inspecting elements of an oversized list", () => {
  const files = Array(33).fill("unused.txt");
  let inspected = false;
  Object.defineProperty(files, 0, {
    enumerable: true,
    get() {
      inspected = true;
      return "surprise.txt";
    },
  });
  assert.throws(() => validateInputWithContext({ prompt: "p", files }), /at most 32 paths/);
  assert.equal(inspected, false);
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

test("structured schema preflight rejects oversized, deep, cyclic, and non-JSON data", () => {
  assert.throws(
    () =>
      validateInputStructured({
        prompt: "p",
        schema: { description: "x".repeat(100 * 1024) },
      }),
    /schema.*exceeds.*serialized/,
  );

  let deep = { type: "string" };
  for (let i = 0; i < 66; i++) deep = { items: deep };
  assert.throws(() => serializeSchemaForCli(deep), /maximum depth 64/);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => serializeSchemaForCli(cyclic), /cyclic/);
  assert.throws(() => serializeSchemaForCli({ minimum: Infinity }), /finite JSON numbers/);
  assert.throws(() => serializeSchemaForCli({ default: new Date() }), /plain JSON objects/);
});

test("schema node bounds apply during discovery of very wide objects", () => {
  const properties = {};
  let gettersRead = 0;
  for (let i = 0; i < 10_001; i++) {
    Object.defineProperty(properties, `field_${i}`, {
      enumerable: true,
      get() {
        gettersRead++;
        return { type: "string" };
      },
    });
  }
  assert.throws(
    () => serializeSchemaForCli({ type: "object", properties }),
    /exceeds 10000 JSON nodes/,
  );
  assert.ok(gettersRead < 10_001, "discovery must stop before eagerly reading every property");
});

test("schema text bounds reject huge strings before JSON serialization", () => {
  const huge = "x".repeat(2 * 1024 * 1024);
  const originalStringify = JSON.stringify;
  let stringifyCalled = false;
  JSON.stringify = (...args) => {
    stringifyCalled = true;
    return originalStringify(...args);
  };
  try {
    assert.throws(() => serializeSchemaForCli({ description: huge }), /serialized UTF-8 bytes/);
    assert.equal(stringifyCalled, false);
  } finally {
    JSON.stringify = originalStringify;
  }
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

test("validateAgainstSchema supports JSON Schema union type arrays", () => {
  const nullableString = { type: ["string", "null"] };
  assert.doesNotThrow(() => validateAgainstSchema("hello", nullableString));
  assert.doesNotThrow(() => validateAgainstSchema(null, nullableString));
  assert.throws(() => validateAgainstSchema(42, nullableString), /string \| null/);

  const objectUnion = {
    type: ["object", "null"],
    required: ["name"],
    properties: { name: { type: "string" } },
  };
  assert.throws(() => validateAgainstSchema({}, objectUnion), /missing required field 'name'/);
  assert.throws(() => validateAgainstSchema({ name: 3 }, objectUnion), /expected type 'string'/);
});

test("validateAgainstSchema required/properties checks ignore inherited fields", () => {
  assert.throws(
    () => validateAgainstSchema({}, { type: "object", required: ["toString"] }),
    /missing required field 'toString'/,
  );
  assert.doesNotThrow(() =>
    validateAgainstSchema(
      { toString: "own" },
      { type: "object", required: ["toString"], properties: { toString: { type: "string" } } },
    ),
  );
});
