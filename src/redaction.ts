/**
 * Secret redaction for anything that can reach an MCP client or a log line.
 * Client-facing text is also capped at ERROR_SNIPPET_MAX.
 */

export const ERROR_SNIPPET_MAX = 1024;
const REDACTION_PATTERN_LOOKAHEAD = 256;

const SECRET_ENV_KEYS = new Set([
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
  // Normally blocked from the child, but operators may explicitly forward
  // them. Their values can contain credentials or signed headers.
  "CLAUDE_CODE_EXTRA_BODY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_SHELL_PREFIX",
]);

/**
 * Values to redact verbatim: known auth variables, keys named in
 * CLAUDECODE_MCP_EXTRA_ENV, and caller-supplied values (for example a
 * profile's `env`, which never lives in process.env). Longest first so a
 * secret that contains another is removed whole.
 */
function secretValues(extra: readonly string[] = []): string[] {
  const extraKeys = new Set(
    (process.env.CLAUDECODE_MCP_EXTRA_ENV ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
  );
  const values = Object.entries(process.env)
    .filter(([key, value]) => value && (SECRET_ENV_KEYS.has(key) || extraKeys.has(key)))
    .map(([, value]) => value!);
  values.push(...extra.filter(Boolean));
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

function redactPatternSecrets(text: string): string {
  let out = text;
  out = out.replace(/sk-ant-[A-Za-z0-9_\-]+/g, "sk-ant-***");
  out = out.replace(/\bBearer[ \t]+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer ***");
  out = out.replace(/\bAKIA[A-Z0-9]{16}\b/g, "***"); // AWS access key IDs
  out = out.replace(/\bASIA[A-Z0-9]{16}\b/g, "***"); // AWS temporary (STS) key IDs
  return out;
}

export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let out = redactPatternSecrets(text);
  for (const value of secretValues(extraSecrets)) {
    out = out.replaceAll(value, "***");
  }
  return out;
}

/**
 * Redact and cap text for an MCP client. Only a window at the start of the
 * text is copied, so a very large stderr is never redacted in full just to
 * return 1 KiB. Exact secret matches are found against the original text so
 * a secret that crosses the window edge is still removed whole.
 */
export function sanitizeForClient(
  text: string,
  startOffset = 0,
  extraSecrets: readonly string[] = [],
): string {
  const offset = Number.isFinite(startOffset)
    ? Math.max(0, Math.min(text.length, Math.trunc(startOffset)))
    : 0;
  const rawWindow = text.slice(offset, offset + ERROR_SNIPPET_MAX + REDACTION_PATTERN_LOOKAHEAD);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const value of secretValues(extraSecrets)) {
    // The offset can land inside a secret; redact the visible suffix too.
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
        ranges.push({ start, end: Math.min(start + value.length, rawWindow.length) });
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
