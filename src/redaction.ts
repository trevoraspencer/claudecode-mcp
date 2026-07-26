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
const REDACTION_PATTERN_LOOKAHEAD = 256;

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
function secretEnvValues(): string[] {
  const knownEnvKeys = new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "AZURE_CLIENT_SECRET",
    "AZURE_CLIENT_CERTIFICATE_PASSWORD",
    "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
    // These are normally blocked from the child, but operators may explicitly
    // forward them. Their values can contain credentials or signed headers.
    "CLAUDE_CODE_EXTRA_BODY",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_SHELL_PREFIX",
  ]);
  const extraEnvKeys = new Set<string>();
  for (const key of (process.env.CLAUDECODE_MCP_EXTRA_ENV ?? "").split(",")) {
    const trimmed = key.trim();
    if (trimmed) extraEnvKeys.add(process.platform === "win32" ? trimmed.toUpperCase() : trimmed);
  }
  const values = Object.entries(process.env)
    .filter(([key, value]) => {
      if (!value) return false;
      if (knownEnvKeys.has(key.toUpperCase())) return true;
      const comparableKey = process.platform === "win32" ? key.toUpperCase() : key;
      return extraEnvKeys.has(comparableKey);
    })
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
  return [...new Set(values)];
}

function redactPatternSecrets(text: string): string {
  let out = text;
  out = out.replace(/sk-ant-[A-Za-z0-9_\-]+/g, "sk-ant-***");
  out = out.replace(/\bBearer[ \t]+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer ***");
  // SEC-006: Extended patterns for common cloud-provider and auth key formats
  out = out.replace(/\bAKIA[A-Z0-9]{16}\b/g, "***"); // AWS access key IDs
  out = out.replace(/\bASIA[A-Z0-9]{16}\b/g, "***"); // AWS temporary (STS) access key IDs
  return out;
}

export function redactSecrets(text: string): string {
  let out = redactPatternSecrets(text);
  for (const value of secretEnvValues()) {
    // OBS-006: Redact non-empty env-var values regardless of length.
    // Previously, values shorter than 5 characters were silently skipped,
    // which could leak short test credentials.
    out = out.replaceAll(value, "***");
  }
  return out;
}

/**
 * Sanitize text for MCP client consumption: redact secrets and truncate
 * to the error snippet maximum (1 KB).
 */
export function sanitizeForClient(text: string, startOffset = 0): string {
  const offset = Number.isFinite(startOffset)
    ? Math.max(0, Math.min(text.length, Math.trunc(startOffset)))
    : 0;
  // Only the beginning can reach the client. Avoid copying/redacting a full
  // (up to 50 MiB) subprocess stderr just to return a 1 KiB message. Exact
  // env-value matches are found against the original text so a long secret
  // crossing the window boundary is still removed in full.
  const rawWindow = text.slice(offset, offset + ERROR_SNIPPET_MAX + REDACTION_PATTERN_LOOKAHEAD);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const value of secretEnvValues()) {
    // If the caller skips leading noise/whitespace, the offset can land in the
    // middle of a secret (for example an explicitly forwarded value that
    // itself begins with spaces). Redact the visible suffix as well.
    const earliestOverlap = Math.max(0, offset - value.length + 1);
    for (let precedingStart = offset - 1; precedingStart >= earliestOverlap; precedingStart--) {
      if (text[precedingStart] === value[0] && text.startsWith(value, precedingStart)) {
        ranges.push({
          start: 0,
          end: Math.min(precedingStart + value.length - offset, rawWindow.length),
        });
        break;
      }
    }
    let from = 0;
    while (from < rawWindow.length) {
      const start = rawWindow.indexOf(value[0]!, from);
      if (start < 0) break;
      if (text.startsWith(value, offset + start)) {
        ranges.push({
          start,
          end: Math.min(start + value.length, rawWindow.length),
        });
      }
      from = start + 1;
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  let exactRedacted = "";
  let cursor = 0;
  for (const range of merged) {
    exactRedacted += rawWindow.slice(cursor, range.start) + "***";
    cursor = range.end;
  }
  exactRedacted += rawWindow.slice(cursor);

  const redacted = redactPatternSecrets(exactRedacted);
  if (redacted.length <= ERROR_SNIPPET_MAX && text.length - offset <= rawWindow.length) {
    return redacted;
  }
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
  // Avoid trim() on a potentially 50 MiB captured stream: it can allocate a
  // second giant string before the 1 KiB sanitizer gets a chance to bound it.
  const stderrStart = stderr.search(/\S/);
  const stdoutStart = stdout.search(/\S/);
  const source = stderrStart >= 0 ? stderr : stdout;
  const start = stderrStart >= 0 ? stderrStart : Math.max(stdoutStart, 0);
  const redacted = sanitizeForClient(source, start).trimEnd();
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
