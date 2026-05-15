/**
 * Secret redaction and error sanitization utilities.
 *
 * These functions redact sensitive patterns (API keys, bearer tokens, etc.)
 * from text before it reaches MCP clients, and cap error messages at 1 KB
 * to prevent information leakage in oversized error responses.
 */

import { debugLog, errorLog } from "./invoke.js";

const ERROR_SNIPPET_MAX = 1024;

export { ERROR_SNIPPET_MAX };

/**
 * Classify a CLI subprocess exit code into a human-readable category.
 */
export function classifyClaudeExit(code: number | null): string {
  if (code === 0) return "ok";
  if (code === null) return "unknown";
  if (code === 1) return "error";
  if (code === 2) return "usage_error";
  return `exit_${code}`;
}

/**
 * Redact known secret patterns from text. Covers Anthropic token patterns,
 * AWS key patterns, and env-var values for standard auth variables.
 */
export function redactSecrets(text: string): string {
  let out = text;
  // Anthropic token patterns
  out = out.replace(/sk-ant-[A-Za-z0-9_\-]+/g, "sk-ant-***");
  out = out.replace(/Bearer\s+[A-Za-z0-9_\-.=]+/g, "Bearer ***");
  // SEC-006: Extended patterns for common cloud-provider and auth key formats
  out = out.replace(/\bAKIA[A-Z0-9]{16}\b/g, "***"); // AWS access key IDs
  out = out.replace(/\bASIA[A-Z0-9]{16}\b/g, "***"); // AWS temporary (STS) access key IDs
  // Env-var values from the standard auth key list
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_FOUNDRY_API_KEY",
  ]) {
    const v = process.env[key];
    // OBS-006: Redact non-empty env-var values regardless of length.
    // Previously, values shorter than 5 characters were silently skipped,
    // which could leak short test credentials.
    if (v && v.length > 0) {
      out = out.replaceAll(v, "***");
    }
  }
  return out;
}

/**
 * Sanitize text for MCP client consumption: redact secrets and truncate
 * to the error snippet maximum (1 KB).
 */
export function sanitizeForClient(text: string): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= ERROR_SNIPPET_MAX) return redacted;
  return redacted.slice(0, ERROR_SNIPPET_MAX) + "...[truncated]";
}

/**
 * Build a redacted, truncated error for a CLI subprocess failure.
 * Logs structured context via debugLog (opt-in) and errorLog (always-on),
 * both emitting structured JSON lines to stderr.
 *
 * ARCH-008: This function creates errors that are thrown by runClaudePrompt*
 * and caught by handleCallTool. The throw-vs-return contract is:
 * - runClaudePrompt* functions throw on failure
 * - handleCallTool catches throws and converts them to {isError: true} MCP responses
 */
export function exitError(exitCode: number | null, stderr: string, stdout: string): Error {
  const raw = stderr.trim() || stdout.trim();
  const redacted = sanitizeForClient(raw);
  // OBS-008: Route through structured debugLog so all error-context logging
  // is gated and formatted consistently. Use errorLog for the always-on
  // structured diagnostic (replaces unstructured console.error).
  debugLog({
    phase: "subprocess_error",
    exit_code: exitCode,
    stderr_snippet: redacted.slice(0, 500),
  });
  // OBS-001: Always-on structured error log — not gated by DEBUG, machine-parseable.
  errorLog({
    phase: "subprocess_error",
    exit_code: exitCode,
    stderr_preview: redacted.slice(0, 200),
  });
  return new Error(`claude CLI exited ${exitCode} (${classifyClaudeExit(exitCode)}): ${redacted}`);
}
