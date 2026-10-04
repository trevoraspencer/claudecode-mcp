/**
 * Structured stderr logging. stdout belongs to the MCP transport, so every
 * diagnostic is one JSON line on stderr. `debugLog` is gated by
 * `DEBUG=claudecode-mcp`; info, warnings, and errors are always on.
 */

export const LOG_TAG = "claudecode-mcp";

export function debugEnabled(): boolean {
  return (process.env.DEBUG ?? "").split(/[,\s]+/).includes(LOG_TAG);
}

function write(level: string | undefined, event: Record<string, unknown>): void {
  try {
    const line: Record<string, unknown> = { ts: new Date().toISOString(), tag: LOG_TAG };
    if (level) line.level = level;
    process.stderr.write(JSON.stringify({ ...line, ...event }) + "\n");
  } catch {
    // best-effort logging
  }
}

export function debugLog(event: Record<string, unknown>): void {
  if (debugEnabled()) write(undefined, event);
}

export function infoLog(event: Record<string, unknown>): void {
  write("info", event);
}

export function warnLog(event: Record<string, unknown>): void {
  write("warn", event);
}

export function errorLog(event: Record<string, unknown>): void {
  write("error", event);
}

export function fatalLog(event: Record<string, unknown>): void {
  write("fatal", event);
}
