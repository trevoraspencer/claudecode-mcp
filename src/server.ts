#!/usr/bin/env node
/**
 * MCP server wiring, tool definitions, and request dispatch.
 *
 * This module is the main entry point for the claudecode-mcp stdio server.
 * It wires up the MCP SDK, defines the three tool schemas, and dispatches
 * tool-call requests to the appropriate handler functions.
 *
 * ## Module Organization (ARCH-001)
 *
 * Cohesive groups are extracted into focused modules:
 * - `validators.ts` — input validation and schema validation
 * - `redaction.ts` — secret redaction, sanitization, and error formatting
 * - `flag-probe.ts` — `--json-schema` flag probe with time-based cache
 * - `env.ts` — shared environment-variable utilities
 * - `invoke.ts` — subprocess spawning, env allowlist, JSON parsing
 * - `path-guard.ts` — file path containment validation
 *
 * All are re-exported here for backward compatibility with test imports.
 *
 * ## Error-Handling Contract (ARCH-008)
 *
 * - Internal `runClaudePrompt*` functions **throw** on failure.
 * - `handleCallTool` is the MCP boundary that **catches** throws and converts
 *   them to `{isError: true}` MCP tool-call responses.
 * - This two-layer pattern ensures internal errors are always surfaced to MCP
 *   clients as structured error responses rather than unhandled exceptions.
 *
 * ## Logging Contract (ARCH-006)
 *
 * - `errorLog` provides **always-on** structured JSON error diagnostics on
 *   stderr (level="error"), used for subprocess exits and request failures.
 *   These are machine-parseable and always visible regardless of configuration.
 * - `warnLog` provides **always-on** structured JSON warning diagnostics
 *   (level="warn") for important but non-fatal conditions.
 * - `debugLog` is for **opt-in** structured JSON-line observability, gated by
 *   `DEBUG=claudecode-mcp`. Use debugLog for request tracing, timing, cache
 *   behavior, and non-fatal diagnostics.
 * - `console.error` is used only as a fallback when structured logging itself
 *   fails (e.g., in the fatal error catch block).
 *
 * ## Public API Surface (ARCH-005)
 *
 * Named exports are deliberately broad to support direct test imports from
 * `dist/server.js`. The stable public surface (used by MCP clients and the
 * bin entrypoint) is: `listTools`, `handleCallTool`. All other exports are
 * available for testing but follow the same backward-compatibility rules.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { invokeCli, parseJsonLoose, debugLog, errorLog } from "./invoke.js";

// Re-export all public symbols for backward compatibility with test imports
export { debugEnabled, warnLog, errorLog } from "./invoke.js";
export {
  classifyClaudeExit,
  redactSecrets,
  sanitizeForClient,
  exitError,
  ERROR_SNIPPET_MAX,
} from "./redaction.js";
export { isJsonSchemaFlagAvailable, resetFlagCache, getClaudeBin } from "./flag-probe.js";
export {
  validateInput,
  validateInputWithContext,
  validateInputStructured,
  validateAgainstSchema,
} from "./validators.js";
export type {
  ClaudePromptInput,
  ClaudePromptWithContextInput,
  ClaudePromptStructuredInput,
} from "./validators.js";
import { safeReadFileUnderCwd } from "./path-guard.js";
import { realpath } from "node:fs/promises";
import { exitError, sanitizeForClient, redactSecrets } from "./redaction.js";
import { getClaudeBin, isJsonSchemaFlagAvailable } from "./flag-probe.js";
import {
  validateInput,
  validateInputWithContext,
  validateInputStructured,
  validateAgainstSchema,
} from "./validators.js";
import type {
  ClaudePromptInput,
  ClaudePromptWithContextInput,
  ClaudePromptStructuredInput,
} from "./validators.js";

function getPackageVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Tool schema definitions ─────────────────────────────────────────

const CLAUDE_PROMPT_TOOL = {
  name: "claude_prompt",
  description:
    "Run a one-shot prompt against the Claude Code CLI in headless, " +
    "stateless mode (no session persistence, no resume). Returns the model's " +
    "text response. Uses the server process's current working directory.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The user prompt to send to Claude Code.",
      },
      model: {
        type: "string",
        description: "Optional Claude model alias or full name (e.g. 'sonnet', 'opus').",
      },
      system_prompt: {
        type: "string",
        description: "Optional system prompt to use for this turn.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
} as const;

const CLAUDE_PROMPT_WITH_CONTEXT_TOOL = {
  name: "claude_prompt_with_context",
  description:
    "Run a one-shot prompt against the Claude Code CLI in headless, stateless " +
    "mode, with additional free-form context and/or file contents prepended to " +
    "the prompt. Returns the model's text response. File paths must be " +
    "relative paths inside the server process's current working directory; " +
    "absolute paths, '..' escapes, and symlinks pointing outside cwd are " +
    "rejected. Each file is also capped at CLAUDECODE_MCP_MAX_FILE_BYTES " +
    "(default 5 MB).",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The user prompt to send to Claude Code.",
      },
      context: {
        type: "string",
        description: "Optional free-form context text to prepend to the prompt.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional list of relative file paths whose contents will be read " +
          "and prepended to the prompt as labeled context blocks.",
      },
      model: {
        type: "string",
        description: "Optional Claude model alias or full name (e.g. 'sonnet', 'opus').",
      },
      system_prompt: {
        type: "string",
        description: "Optional system prompt to use for this turn.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
} as const;

const CLAUDE_PROMPT_STRUCTURED_TOOL = {
  name: "claude_prompt_structured",
  description:
    "Run a one-shot prompt against the Claude Code CLI in headless, stateless " +
    "mode and return a structured JSON object. Requires `schema` (a JSON " +
    "Schema). The Claude CLI validates the output server-side via its " +
    "--json-schema flag; this server performs an additional lightweight " +
    "sanity check (top-level type, required fields, recursive `properties` " +
    "types only — does NOT check items/enum/min/max/pattern/etc). Returns " +
    "the parsed JSON. Uses the server process's current working directory.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The user prompt to send to Claude Code.",
      },
      schema: {
        type: "object",
        description:
          "Required JSON Schema describing the expected shape of the model's " +
          "JSON output. Passed to the CLI as --json-schema and used for a " +
          "post-hoc sanity check.",
        additionalProperties: true,
      },
      model: {
        type: "string",
        description: "Optional Claude model alias or full name (e.g. 'sonnet', 'opus').",
      },
      system_prompt: {
        type: "string",
        description: "Optional system prompt to use for this turn.",
      },
    },
    required: ["prompt", "schema"],
    additionalProperties: false,
  },
} as const;

// ── CLI arg building ─────────────────────────────────────────────────

export function baseClaudeArgs(): string[] {
  // --bare is opt-in (CLAUDECODE_MCP_BARE=1) because it disables OAuth/keychain
  // and requires ANTHROPIC_API_KEY or an apiKeyHelper via --settings. By
  // default we keep OAuth-friendly behavior but lock down MCP loading so the
  // wrapped subprocess can't recursively load the user's own MCP servers
  // (including this one) or arbitrary local config.
  const bare = process.env.CLAUDECODE_MCP_BARE === "1";
  const args: string[] = [];
  if (bare) {
    args.push("--bare");
  }
  args.push("--print", "--permission-mode", "bypassPermissions", "--no-session-persistence");
  if (!bare) {
    // --bare already excludes MCP loading; only add the strict pin in
    // non-bare mode where ambient MCP would otherwise be picked up.
    args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
  }
  args.push("--output-format", "json");
  return args;
}

/**
 * H1: Maximum prompt size (in UTF-8 bytes) that may travel as a single argv
 * element. Linux caps each argv string at MAX_ARG_STRLEN (128 KiB); larger
 * prompts made spawn fail with a raw `E2BIG` before the CLI even started,
 * which broke the documented 5 MB per-file context capacity. 100 KiB leaves
 * headroom under the 128 KiB OS limit.
 */
export const MAX_PROMPT_ARG_BYTES = 100 * 1024;

/**
 * H1: Route the prompt onto argv (small prompts — preserves the existing
 * argv contract) or via stdin (large prompts — avoids the per-argument OS
 * limit). `claude --print` reads the prompt from stdin when no positional
 * prompt argument is given (`--input-format` defaults to "text").
 *
 * M1: When the prompt travels on argv it is preceded by a `--` end-of-options
 * separator so the CLI can never parse prompt text as flags. Without it, a
 * prompt beginning with `-` (e.g. "--continue", or any composite prompt —
 * composites always start with a "----- context/file -----" fence) would be
 * consumed by the CLI's option parser instead of being sent to the model.
 *
 * Mutates `args` (appends `--` and the prompt as the last positional) when
 * the prompt fits on argv and returns undefined; otherwise leaves `args`
 * untouched and returns the prompt to be passed as the subprocess's stdin.
 */
export function routePromptDelivery(args: string[], prompt: string): string | undefined {
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes <= MAX_PROMPT_ARG_BYTES) {
    args.push("--", prompt);
    return undefined;
  }
  debugLog({ phase: "prompt_via_stdin", prompt_bytes: promptBytes });
  return prompt;
}

// ── Shared invocation helper (ARCH-004) ──────────────────────────────

/**
 * Invoke the claude CLI with the given args, check exit code, and parse
 * the response as JSON. This is the shared invocation pattern used by
 * `runClaudePrompt` and `runClaudePromptStructured` (ARCH-004).
 *
 * @throws {Error} on non-zero exit code or parse failure
 */
async function invokeClaudeAndParse(
  args: string[],
  parseErrorPrefix: string,
  stdin?: string,
): Promise<unknown> {
  const result = await invokeCli(getClaudeBin(), args, { cwd: process.cwd(), stdin });

  if (result.exitCode !== 0) {
    throw exitError(result.exitCode, result.stderr, result.stdout);
  }

  try {
    return parseJsonLoose(result.stdout);
  } catch (err) {
    // SEC-001: Apply sanitizeForClient so raw CLI stdout (which may contain
    // secrets on parse-failure paths) is redacted before reaching MCP clients.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${parseErrorPrefix}: ${sanitizeForClient(msg)}`);
  }
}

// ── Business-logic handlers ──────────────────────────────────────────

/**
 * @throws {Error} on CLI failure, parse failure, or unexpected response shape.
 * (ARCH-008: handleCallTool catches these throws and converts to isError responses.)
 */
export async function runClaudePromptStructured(
  input: ClaudePromptStructuredInput,
): Promise<unknown> {
  if (!input.schema) {
    throw new Error("claude_prompt_structured requires a `schema` (JSON Schema) argument");
  }

  const flagOk = await isJsonSchemaFlagAvailable();
  if (!flagOk) {
    throw new Error(
      "claude_prompt_structured: installed `claude` CLI does not support " +
        "the --json-schema flag. Upgrade Claude Code or use claude_prompt.",
    );
  }

  const args: string[] = baseClaudeArgs();
  args.push("--json-schema", JSON.stringify(input.schema));
  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.system_prompt) {
    args.push("--append-system-prompt", input.system_prompt);
  }
  // H1: Large prompts travel via stdin instead of argv to avoid E2BIG.
  const stdinPrompt = routePromptDelivery(args, input.prompt);

  const rawParsed = await invokeClaudeAndParse(args, "claude_prompt_structured", stdinPrompt);
  if (!rawParsed || typeof rawParsed !== "object" || Array.isArray(rawParsed)) {
    throw new Error("claude CLI returned a non-object payload");
  }
  const outerObj = rawParsed as Record<string, unknown>;

  // With --json-schema, Claude Code puts the schema-conforming value in
  // outer.structured_output. The `result` field carries a natural-language
  // summary and must NOT be parsed as the structured payload.
  const parsed = outerObj.structured_output;
  if (parsed === undefined) {
    // L2: Redact before truncating (matching every other call site). Slicing
    // first could cut a secret at the boundary so it no longer exact-matches
    // the env-value replaceAll in redactSecrets, leaking the secret's prefix.
    const summary = sanitizeForClient(String(outerObj.result ?? "")).slice(0, 200);
    throw new Error(`claude CLI returned no structured_output field (result: ${summary})`);
  }
  validateAgainstSchema(parsed, input.schema);
  return parsed;
}

const FILE_BLOCK_FENCE = "----- file:";

export function escapePathForFence(p: string): string {
  let out = p.replace(/[\r\n]+/g, " ");
  // SEC-010: Replace runs of 5+ hyphens (matching our fence delimiter pattern)
  // with em-dashes to prevent fence boundary confusion in the composite prompt.
  out = out.replace(/-{5,}/g, "—————");
  return out;
}

async function buildCompositePrompt(input: ClaudePromptWithContextInput): Promise<string> {
  const blocks: string[] = [];
  if (input.context && input.context.length > 0) {
    blocks.push(`----- context -----\n${input.context}\n----- end context -----`);
  }
  if (input.files && input.files.length > 0) {
    // PERF-003: Compute realpath(cwd) once per request instead of per file.
    const baseReal = await realpath(process.cwd());
    // PERF-002: Resolve and read all files in parallel via Promise.all.
    // Promise.all preserves input order, so blocks are assembled in the
    // same order as the caller's file list.
    const fileResults = await Promise.all(
      input.files.map(async (path) => {
        // SEC-004: Use safeReadFileUnderCwd for atomic fd-based validation +
        // read, eliminating the TOCTOU race between path-guard stat() and
        // readFile() that existed when these were separate steps.
        let body: string;
        try {
          body = await safeReadFileUnderCwd(path, process.cwd(), baseReal);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`failed to include file ${path}: ${msg}`);
        }
        return { path, body };
      }),
    );
    // Build blocks in original file order.
    for (const { path, body } of fileResults) {
      const safePath = escapePathForFence(path);
      // CORR-004: Replace sentinel-fence-like patterns in file contents so
      // they cannot break the block boundary markers.
      const safeBody = body.replace(/^-{5}\s*(file|end file|context|end context)\b/gm, "     $1");
      blocks.push(`${FILE_BLOCK_FENCE} ${safePath} -----\n${safeBody}\n----- end file -----`);
    }
  }
  if (blocks.length === 0) {
    return input.prompt;
  }
  return `${blocks.join("\n\n")}\n\n${input.prompt}`;
}

export async function runClaudePromptWithContext(
  input: ClaudePromptWithContextInput,
): Promise<string> {
  const composite = await buildCompositePrompt(input);
  return runClaudePrompt({
    prompt: composite,
    model: input.model,
    system_prompt: input.system_prompt,
  });
}

/**
 * @throws {Error} on CLI failure or parse failure.
 * (ARCH-008: handleCallTool catches these throws and converts to isError responses.)
 */
export async function runClaudePrompt(input: ClaudePromptInput): Promise<string> {
  const args: string[] = baseClaudeArgs();
  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.system_prompt) {
    args.push("--append-system-prompt", input.system_prompt);
  }
  // H1: Large prompts (including composites built from up-to-5 MB context
  // files) travel via stdin instead of argv to avoid E2BIG.
  const stdinPrompt = routePromptDelivery(args, input.prompt);

  const parsed = await invokeClaudeAndParse(
    args,
    "claude CLI output was not parseable JSON (--output-format json expected)",
    stdinPrompt,
  );
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.result === "string") return obj.result;
    if (typeof obj.response === "string") return obj.response;
    // CORR-003: Log unexpected JSON shape for observability. The fallback to
    // JSON.stringify is preserved for backward compatibility, but this
    // indicates CLI contract drift and should be investigated.
    debugLog({
      phase: "unexpected_json_shape",
      has_result: typeof obj.result,
      has_response: typeof obj.response,
      top_keys: Object.keys(obj).slice(0, 10),
    });
    return JSON.stringify(obj);
  }
  // CORR-003: Same warning for non-object (array/primitive) responses.
  debugLog({
    phase: "unexpected_json_type",
    parsed_type: Array.isArray(parsed) ? "array" : typeof parsed,
  });
  return JSON.stringify(parsed);
}

// ── Tool listing and dispatch ────────────────────────────────────────

export function listTools(): {
  tools: ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
} {
  return {
    tools: [CLAUDE_PROMPT_TOOL, CLAUDE_PROMPT_WITH_CONTEXT_TOOL, CLAUDE_PROMPT_STRUCTURED_TOOL],
  };
}

/**
 * MCP tool-call dispatch boundary.
 *
 * ARCH-008: This function catches all errors thrown by runClaudePrompt* and
 * converts them to `{isError: true}` MCP tool-call responses. Internal
 * functions throw; this boundary catches and wraps.
 */
export async function handleCallTool(req: {
  params: { name: string; arguments?: unknown };
}): Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}> {
  const start = Date.now();
  const tool = req.params.name;
  const args = req.params.arguments;
  const inputBytes =
    args === undefined || args === null ? 0 : Buffer.byteLength(JSON.stringify(args), "utf8");
  debugLog({ phase: "call", tool, input_bytes: inputBytes });
  // SEC-007: Warn on very large inputs (non-breaking observability only;
  // no rejection to preserve backward compatibility). Documented threshold
  // for operational visibility.
  if (inputBytes > 1_000_000) {
    debugLog({ phase: "large_input", tool, input_bytes: inputBytes, threshold: 1_000_000 });
  }
  try {
    let result;
    if (tool === CLAUDE_PROMPT_TOOL.name) {
      const input = validateInput(args);
      const text = await runClaudePrompt(input);
      result = { content: [{ type: "text" as const, text }] };
    } else if (tool === CLAUDE_PROMPT_WITH_CONTEXT_TOOL.name) {
      const input = validateInputWithContext(args);
      const text = await runClaudePromptWithContext(input);
      result = { content: [{ type: "text" as const, text }] };
    } else if (tool === CLAUDE_PROMPT_STRUCTURED_TOOL.name) {
      const input = validateInputStructured(args);
      const json = await runClaudePromptStructured(input);
      result = {
        content: [{ type: "text" as const, text: JSON.stringify(json) }],
      };
    } else {
      debugLog({
        phase: "call_done",
        tool,
        duration_ms: Date.now() - start,
        error: "unknown_tool",
      });
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${tool}` }],
      };
    }
    debugLog({ phase: "call_done", tool, duration_ms: Date.now() - start, ok: true });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // OBS-002: Log error class and relevant properties for diagnosability.
    const errorInfo: Record<string, unknown> = {
      phase: "call_done",
      tool,
      duration_ms: Date.now() - start,
      error_class: err instanceof Error ? err.constructor.name : typeof err,
      error: message.slice(0, 200),
    };
    if (err instanceof Error && "timeoutMs" in err) {
      errorInfo.timeout_ms = (err as { timeoutMs: number }).timeoutMs;
    }
    if (err instanceof Error && "limitBytes" in err) {
      errorInfo.limit_bytes = (err as { limitBytes: number }).limitBytes;
    }
    debugLog(errorInfo);
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }
}

// ── Server startup ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new Server(
    { name: "claudecode-mcp", version: getPackageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => listTools());
  server.setRequestHandler(CallToolRequestSchema, async (req) => handleCallTool(req));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ARCH-007/CORR-005: Use path.basename for precise entry-point detection
// instead of broad suffix matching (which could match test_server.js, etc.).
const entry = process.argv[1] ?? "";
if (basename(entry) === "server.js" || basename(entry) === "server.ts") {
  main().catch((err) => {
    // OBS-012: Format fatal startup error as structured JSON line for
    // consistent stderr output, then exit. Apply redaction to avoid leaking
    // secrets in env-related startup errors.
    try {
      const msg = err instanceof Error ? err.message : String(err);
      const errClass = err instanceof Error ? err.constructor.name : typeof err;
      const safeMsg = redactSecrets(msg);
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          tag: "claudecode-mcp",
          level: "fatal",
          error_class: errClass,
          error: safeMsg.slice(0, 500),
        }) + "\n",
      );
    } catch {
      // eslint-disable-next-line no-console
      console.error("claudecode-mcp fatal:", err);
    }
    process.exit(1);
  });
}
