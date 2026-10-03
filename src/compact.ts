/**
 * Compact views of the stream-json transcript (events.jsonl) for callers:
 * short steps instead of raw events. The raw log stays on disk unchanged.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface Step {
  kind: string;
  [key: string]: unknown;
}

const TAIL_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + `… [+${text.length - max} chars]` : text;
}

function inputSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description"]) {
    if (typeof o[key] === "string") return cap(o[key] as string, 200);
  }
  return cap(JSON.stringify(o), 200);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : ""))
      .join("");
  }
  return "";
}

/** Turn one raw event into zero or more compact steps. */
export function compactEvent(e: unknown): Step[] {
  if (!e || typeof e !== "object") return [];
  const ev = e as Record<string, unknown>;
  switch (ev.type) {
    case "system":
      return ev.subtype === "init"
        ? [{ kind: "turn_start", model: ev.model, permission_mode: ev.permissionMode }]
        : [];
    case "assistant": {
      const content = (ev.message as { content?: unknown })?.content;
      if (!Array.isArray(content)) return [];
      const steps: Step[] = [];
      for (const c of content) {
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
          steps.push({ kind: "text", text: cap(c.text, 300) });
        } else if (c?.type === "tool_use") {
          steps.push({ kind: "tool", name: c.name, input: inputSummary(c.input) });
        }
      }
      return steps;
    }
    case "user": {
      const content = (ev.message as { content?: unknown })?.content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((c) => c?.type === "tool_result" && c.is_error === true)
        .map((c) => ({ kind: "tool_error", text: cap(contentText(c.content), 300) }));
    }
    case "result":
      return [
        {
          kind: "result",
          subtype: ev.subtype,
          is_error: ev.is_error === true,
          ...(typeof ev.result === "string" ? { text: cap(ev.result, 500) } : {}),
        },
      ];
    case "rate_limit_event": {
      const info = (ev.rate_limit_info ?? {}) as Record<string, unknown>;
      return [
        {
          kind: "rate_limit",
          status: info.status,
          type: info.rateLimitType,
          utilization: info.utilization,
        },
      ];
    }
    default:
      return [];
  }
}

function readBytes(path: string, start: number, maxBytes: number): { buf: Buffer; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const from = Math.min(Math.max(0, start), size);
    const len = Math.min(maxBytes, size - from);
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, from + read);
      if (n === 0) break;
      read += n;
    }
    return { buf: buf.subarray(0, read), size };
  } finally {
    closeSync(fd);
  }
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The last `n` compact steps of a transcript. */
export function recentSteps(eventsPath: string, n: number): Step[] {
  if (n <= 0) return [];
  let buf: Buffer;
  try {
    const size = readBytes(eventsPath, 0, 0).size;
    const from = Math.max(0, size - TAIL_BYTES);
    buf = readBytes(eventsPath, from, TAIL_BYTES).buf;
    // Drop a partial first line when the tail starts mid-file.
    if (from > 0) buf = buf.subarray(buf.indexOf(0x0a) + 1);
  } catch {
    return [];
  }
  const steps = buf
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => compactEvent(parse(line)));
  return steps.slice(-n);
}

export interface EventsPage {
  events: Array<{ offset: number; type: string; steps: Step[]; skipped_bytes?: number }>;
  next_cursor: number;
  eof: boolean;
}

/** Byte offset of the next line start at or after `pos` (EOF if none). */
function nextLineStart(path: string, pos: number): number {
  for (;;) {
    const { buf, size } = readBytes(path, pos, TAIL_BYTES);
    if (buf.length === 0) return size;
    const nl = buf.indexOf(0x0a);
    if (nl >= 0) return pos + nl + 1;
    pos += buf.length;
  }
}

/**
 * Read up to `limit` events starting at byte offset `cursor` (0, or a
 * previous page's `next_cursor`). Offsets are byte positions in the file. A
 * cursor that is not at a line start moves forward to the next line. A line
 * longer than the read cap is reported as `type: "oversized"` and skipped.
 */
export function readEventsPage(eventsPath: string, cursor: number, limit: number): EventsPage {
  let start = Math.max(0, Math.floor(cursor));
  let chunk: { buf: Buffer; size: number };
  try {
    if (start > 0 && readBytes(eventsPath, start - 1, 1).buf[0] !== 0x0a) {
      start = nextLineStart(eventsPath, start);
    }
    chunk = readBytes(eventsPath, start, TAIL_BYTES);
    if (!chunk.buf.includes(0x0a) && start + chunk.buf.length < chunk.size) {
      chunk = readBytes(eventsPath, start, MAX_LINE_BYTES);
    }
  } catch {
    return { events: [], next_cursor: cursor, eof: true };
  }
  const events: EventsPage["events"] = [];
  let offset = Math.min(start, chunk.size);
  let pos = 0;
  while (events.length < limit) {
    const nl = chunk.buf.indexOf(0x0a, pos);
    if (nl < 0) {
      // A full chunk with no newline is one oversized line: step over it.
      if (pos === 0 && chunk.buf.length >= MAX_LINE_BYTES) {
        const next = nextLineStart(eventsPath, offset + chunk.buf.length);
        events.push({ offset, type: "oversized", steps: [], skipped_bytes: next - offset });
        offset = next;
      }
      break;
    }
    const line = chunk.buf.subarray(pos, nl).toString("utf8");
    const e = parse(line) as { type?: unknown } | null;
    events.push({
      offset,
      type: typeof e?.type === "string" ? e.type : "unknown",
      steps: compactEvent(e),
    });
    offset += nl + 1 - pos;
    pos = nl + 1;
  }
  return { events, next_cursor: offset, eof: offset >= chunk.size };
}
