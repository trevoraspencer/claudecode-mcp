/**
 * Input validation and schema validation for MCP tool arguments.
 *
 * These functions cast `unknown` MCP tool arguments to typed interfaces after
 * validating required fields and types. `validateAgainstSchema` provides a
 * lightweight sanity check for structured-output payloads (the CLI's
 * `--json-schema` flag is the authoritative validator).
 */

// ── Input type interfaces ──────────────────────────────────────────

export interface ClaudePromptInput {
  prompt: string;
  model?: string;
  system_prompt?: string;
}

export interface ClaudePromptWithContextInput extends ClaudePromptInput {
  context?: string;
  files?: string[];
}

export interface ClaudePromptStructuredInput extends ClaudePromptInput {
  schema?: Record<string, unknown>;
}

// Values passed as individual argv elements must stay below Linux's
// MAX_ARG_STRLEN (128 KiB). Leave headroom for platform/runtime overhead.
export const MAX_SYSTEM_PROMPT_ARG_BYTES = 100 * 1024;
export const MAX_SCHEMA_ARG_BYTES = 100 * 1024;
export const MAX_MODEL_BYTES = 512;
export const MAX_CONTEXT_FILES = 32;
export const MAX_SCHEMA_DEPTH = 64;
export const MAX_SCHEMA_NODES = 10_000;
const PROMPT_KEYS = new Set(["prompt", "model", "system_prompt"]);
const CONTEXT_KEYS = new Set(["prompt", "model", "system_prompt", "context", "files"]);
const STRUCTURED_KEYS = new Set(["prompt", "model", "system_prompt", "schema"]);

function validateOptionalCliArgs(model?: string, systemPrompt?: string): void {
  if (model !== undefined) {
    if (model.length === 0) {
      throw new Error("`model` must not be empty");
    }
    if (Buffer.byteLength(model, "utf8") > MAX_MODEL_BYTES) {
      throw new Error(`\`model\` exceeds ${MAX_MODEL_BYTES} UTF-8 bytes`);
    }
    // `--model VALUE` is an argv pair, but option parsers can still interpret
    // a leading dash as the next flag. Model identifiers never need control
    // characters or whitespace.
    if (model.startsWith("-") || /[\x00-\x20\x7f]/.test(model)) {
      throw new Error("`model` contains whitespace/control characters or begins with '-'");
    }
  }
  if (systemPrompt !== undefined) {
    if (systemPrompt.includes("\0")) {
      throw new Error("`system_prompt` must not contain NUL characters");
    }
    const bytes = Buffer.byteLength(systemPrompt, "utf8");
    if (bytes > MAX_SYSTEM_PROMPT_ARG_BYTES) {
      throw new Error(`\`system_prompt\` exceeds ${MAX_SYSTEM_PROMPT_ARG_BYTES} UTF-8 bytes`);
    }
  }
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

/**
 * Validate that a schema is bounded JSON data, then serialize it for the
 * CLI's `--json-schema` argv value. The CLI remains the authoritative schema
 * validator; these checks only prevent cycles, lossy JSON coercion, excessive
 * recursion, and operating-system argv failures.
 */
export function serializeSchemaForCli(schema: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }];
  let nodes = 0;
  let schemaTextBytes = 0;
  const accountSchemaText = (text: string): void => {
    schemaTextBytes += Buffer.byteLength(text, "utf8");
    if (schemaTextBytes > MAX_SCHEMA_ARG_BYTES) {
      throw new Error(`\`schema\` exceeds ${MAX_SCHEMA_ARG_BYTES} serialized UTF-8 bytes`);
    }
  };

  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes++;
    if (nodes > MAX_SCHEMA_NODES) {
      throw new Error(`\`schema\` exceeds ${MAX_SCHEMA_NODES} JSON nodes`);
    }
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new Error(`\`schema\` exceeds maximum depth ${MAX_SCHEMA_DEPTH}`);
    }
    if (typeof value === "string") {
      // JSON escaping can only increase this UTF-8 lower bound. Reject large
      // text before JSON.stringify allocates a second oversized representation.
      accountSchemaText(value);
      continue;
    }
    if (value === null || typeof value === "boolean") {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error("`schema` must contain only finite JSON numbers");
      }
      continue;
    }
    if (typeof value !== "object") {
      throw new Error("`schema` must contain only JSON-serializable values");
    }
    if (!Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("`schema` must contain only plain JSON objects and arrays");
      }
    }
    const objectValue = value as object;
    if (seen.has(objectValue)) {
      throw new Error("`schema` must not contain cyclic or repeated object references");
    }
    seen.add(objectValue);

    const pushChild = (child: unknown): void => {
      // Bound discovery as well as visitation. Eagerly collecting Object.values
      // from a very wide object could otherwise allocate an unbounded array and
      // stack before the node-count check at the top of the loop ran.
      if (nodes + stack.length >= MAX_SCHEMA_NODES) {
        throw new Error(`\`schema\` exceeds ${MAX_SCHEMA_NODES} JSON nodes`);
      }
      stack.push({ value: child, depth: depth + 1 });
    };
    if (Array.isArray(value)) {
      if (value.length > MAX_SCHEMA_NODES - nodes - stack.length) {
        throw new Error(`\`schema\` exceeds ${MAX_SCHEMA_NODES} JSON nodes`);
      }
      for (let i = value.length - 1; i >= 0; i--) {
        pushChild(value[i]);
      }
    } else {
      const record = value as Record<string, unknown>;
      for (const key in record) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          accountSchemaText(key);
          pushChild(record[key]);
        }
      }
    }
  }

  const serialized = JSON.stringify(schema);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_SCHEMA_ARG_BYTES) {
    throw new Error(`\`schema\` exceeds ${MAX_SCHEMA_ARG_BYTES} serialized UTF-8 bytes`);
  }
  return serialized;
}

// ── Internal shared base validator ──────────────────────────────────

function validateBaseInput(raw: unknown): {
  obj: Record<string, unknown>;
  base: ClaudePromptInput;
} {
  if (!raw || typeof raw !== "object") {
    throw new Error("arguments must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.prompt !== "string" || obj.prompt.length === 0) {
    throw new Error("`prompt` must be a non-empty string");
  }
  if (obj.model !== undefined && typeof obj.model !== "string") {
    throw new Error("`model` must be a string");
  }
  if (obj.system_prompt !== undefined && typeof obj.system_prompt !== "string") {
    throw new Error("`system_prompt` must be a string");
  }
  validateOptionalCliArgs(obj.model as string | undefined, obj.system_prompt as string | undefined);
  return {
    obj,
    base: {
      prompt: obj.prompt,
      model: obj.model as string | undefined,
      system_prompt: obj.system_prompt as string | undefined,
    },
  };
}

// ── Public validators ───────────────────────────────────────────────

export function validateInput(raw: unknown): ClaudePromptInput {
  const { obj, base } = validateBaseInput(raw);
  rejectUnknownKeys(obj, PROMPT_KEYS);
  return base;
}

export function validateInputWithContext(raw: unknown): ClaudePromptWithContextInput {
  const { obj, base } = validateBaseInput(raw);
  rejectUnknownKeys(obj, CONTEXT_KEYS);
  if (obj.context !== undefined && typeof obj.context !== "string") {
    throw new Error("`context` must be a string");
  }
  let files: string[] | undefined;
  if (obj.files !== undefined) {
    if (!Array.isArray(obj.files)) {
      throw new Error("`files` must be an array of strings");
    }
    if (obj.files.length > MAX_CONTEXT_FILES) {
      throw new Error(`\`files\` must contain at most ${MAX_CONTEXT_FILES} paths`);
    }
    for (const f of obj.files) {
      if (typeof f !== "string" || f.length === 0) {
        throw new Error("`files` must be an array of non-empty strings");
      }
    }
    files = obj.files as string[];
  }
  return {
    ...base,
    context: obj.context as string | undefined,
    files,
  };
}

export function validateInputStructured(raw: unknown): ClaudePromptStructuredInput {
  const { obj, base } = validateBaseInput(raw);
  rejectUnknownKeys(obj, STRUCTURED_KEYS);
  let schema: Record<string, unknown> | undefined;
  if (obj.schema !== undefined) {
    if (!obj.schema || typeof obj.schema !== "object" || Array.isArray(obj.schema)) {
      throw new Error("`schema` must be a JSON Schema object");
    }
    schema = obj.schema as Record<string, unknown>;
    serializeSchemaForCli(schema);
  }
  return { ...base, schema };
}

/**
 * Lightweight sanity check on shape: top-level `type`, `required`, and
 * recursive `properties`/`items` type-tags. Does not validate enum, min/max,
 * pattern, additionalProperties, or combiners. The CLI's --json-schema flag
 * is the authoritative validator; this is a belt-and-braces backstop.
 */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): void {
  const rawType = schema.type;
  const expectedTypes =
    typeof rawType === "string"
      ? [rawType]
      : Array.isArray(rawType)
        ? rawType.filter((type): type is string => typeof type === "string")
        : [];
  if (expectedTypes.length > 0) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const ok = expectedTypes.some(
      (expectedType) =>
        (expectedType === "object" && actual === "object") ||
        (expectedType === "array" && actual === "array") ||
        (expectedType === "string" && actual === "string") ||
        (expectedType === "number" && actual === "number") ||
        (expectedType === "integer" && actual === "number" && Number.isInteger(value)) ||
        (expectedType === "boolean" && actual === "boolean") ||
        (expectedType === "null" && actual === "null"),
    );
    if (!ok) {
      throw new Error(
        `schema validation: expected type '${expectedTypes.join(" | ")}', got '${actual}'`,
      );
    }
  }
  if (
    expectedTypes.includes("object") &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(obj, key)) {
          throw new Error(`schema validation: missing required field '${key}'`);
        }
      }
    }
    const props = schema.properties;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      for (const [k, sub] of Object.entries(props as Record<string, unknown>)) {
        if (
          Object.prototype.hasOwnProperty.call(obj, k) &&
          sub &&
          typeof sub === "object" &&
          !Array.isArray(sub)
        ) {
          validateAgainstSchema(obj[k], sub as Record<string, unknown>);
        }
      }
    }
  }
  // TYPE-002: Recurse into array `items` schemas.
  if (expectedTypes.includes("array") && Array.isArray(value)) {
    const items = schema.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      for (const item of value) {
        validateAgainstSchema(item, items as Record<string, unknown>);
      }
    }
  }
}
