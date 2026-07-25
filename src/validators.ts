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
  return validateBaseInput(raw).base;
}

export function validateInputWithContext(raw: unknown): ClaudePromptWithContextInput {
  const { obj, base } = validateBaseInput(raw);
  if (obj.context !== undefined && typeof obj.context !== "string") {
    throw new Error("`context` must be a string");
  }
  let files: string[] | undefined;
  if (obj.files !== undefined) {
    if (!Array.isArray(obj.files)) {
      throw new Error("`files` must be an array of strings");
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
  let schema: Record<string, unknown> | undefined;
  if (obj.schema !== undefined) {
    if (!obj.schema || typeof obj.schema !== "object" || Array.isArray(obj.schema)) {
      throw new Error("`schema` must be a JSON Schema object");
    }
    schema = obj.schema as Record<string, unknown>;
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
  const expectedType = schema.type as string | undefined;
  if (expectedType) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const ok =
      (expectedType === "object" && actual === "object") ||
      (expectedType === "array" && actual === "array") ||
      (expectedType === "string" && actual === "string") ||
      (expectedType === "number" && actual === "number") ||
      (expectedType === "integer" && actual === "number" && Number.isInteger(value)) ||
      (expectedType === "boolean" && actual === "boolean") ||
      (expectedType === "null" && actual === "null");
    if (!ok) {
      throw new Error(`schema validation: expected type '${expectedType}', got '${actual}'`);
    }
  }
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !(key in obj)) {
          throw new Error(`schema validation: missing required field '${key}'`);
        }
      }
    }
    const props = schema.properties;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      for (const [k, sub] of Object.entries(props as Record<string, unknown>)) {
        if (k in obj && sub && typeof sub === "object" && !Array.isArray(sub)) {
          validateAgainstSchema(obj[k], sub as Record<string, unknown>);
        }
      }
    }
  }
  // TYPE-002: Recurse into array `items` schemas.
  if (schema.type === "array" && Array.isArray(value)) {
    const items = schema.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      for (const item of value) {
        validateAgainstSchema(item, items as Record<string, unknown>);
      }
    }
  }
}
