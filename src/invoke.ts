import { spawn } from "node:child_process";
import { numFromEnv } from "./env.js";

const DEBUG_TAG = "claudecode-mcp";

export function debugEnabled(): boolean {
  return (process.env.DEBUG ?? "").split(/[,\s]+/).includes(DEBUG_TAG);
}

export function debugLog(event: Record<string, unknown>): void {
  if (!debugEnabled()) return;
  try {
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), tag: DEBUG_TAG, ...event }) + "\n",
    );
  } catch {
    // best-effort logging
  }
}

/**
 * Always-on structured warning log. Emits a JSON line to stderr regardless
 * of DEBUG setting, with level="warn" for machine-parseable filtering.
 * Use for important operational conditions that should always be visible
 * (e.g., subprocess failures, degraded behavior).
 */
export function warnLog(event: Record<string, unknown>): void {
  try {
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), tag: DEBUG_TAG, level: "warn", ...event }) +
        "\n",
    );
  } catch {
    // best-effort logging
  }
}

/**
 * Always-on structured error log. Emits a JSON line to stderr regardless
 * of DEBUG setting, with level="error" for machine-parseable filtering.
 * Use for errors that affect the current request but do not crash the server.
 */
export function errorLog(event: Record<string, unknown>): void {
  try {
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), tag: DEBUG_TAG, level: "error", ...event }) +
        "\n",
    );
  } catch {
    // best-effort logging
  }
}

export interface InvokeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Subprocess duration in milliseconds from spawn to close. OBS-004 */
  durationMs: number;
}

export interface InvokeOpts {
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export class InvokeTimeoutError extends Error {
  readonly code = "ETIMEDOUT" as const;
  constructor(public readonly timeoutMs: number) {
    super(`claude CLI did not exit within ${timeoutMs}ms (killed)`);
    this.name = "InvokeTimeoutError";
  }
}

export class OutputTooLargeError extends Error {
  readonly code = "EOUTPUTSIZE" as const;
  constructor(public readonly limitBytes: number) {
    super(`claude CLI output exceeded ${limitBytes} bytes (killed)`);
    this.name = "OutputTooLargeError";
  }
}

export class InvokeAbortedError extends Error {
  readonly code = "ABORT_ERR" as const;
  constructor() {
    super("claude CLI invocation was cancelled");
    this.name = "InvokeAbortedError";
  }
}

// Defaults are intentionally generous; the env vars exist so operators can
// tighten them without code changes.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const KILL_GRACE_MS = 2000;
const MAX_TIMER_MS = 2_147_483_647;
// CreateProcessW limits the complete command line, including the executable
// and terminating NUL, to 32,767 UTF-16 code units.
export const WINDOWS_COMMAND_LINE_MAX_UNITS = 32_767;

/**
 * Return the UTF-16 command-line length produced by Node/libuv's default
 * Windows argument quoting. JavaScript string length already counts UTF-16
 * code units, matching CreateProcessW.
 */
function quotedWindowsArgLength(arg: string): number {
  if (arg.length > 0 && !/[ \t"]/.test(arg)) return arg.length;

  // Opening and closing quotes. Backslashes are doubled only before a quote
  // or the closing quote; a literal quote is escaped with one more slash.
  let length = 2;
  let backslashes = 0;
  for (let i = 0; i < arg.length; i++) {
    const char = arg[i]!;
    if (char === "\\") {
      backslashes++;
    } else if (char === '"') {
      length += backslashes * 2 + 2;
      backslashes = 0;
    } else {
      length += backslashes + 1;
      backslashes = 0;
    }
  }
  return length + backslashes * 2;
}

/**
 * Compute the complete Windows command-line length, excluding its terminating
 * NUL. Exported so prompt routing can decide whether stdin is required before
 * the subprocess is spawned.
 */
export function windowsCommandLineLength(command: string, args: readonly string[]): number {
  let length = quotedWindowsArgLength(command);
  for (const arg of args) {
    length += 1 + quotedWindowsArgLength(arg);
  }
  return length;
}

/**
 * Fail with a stable application error before Node/libuv reaches
 * CreateProcessW. This catches oversized non-prompt combinations (for example
 * a large schema plus a large system prompt); prompt payloads are routed to
 * stdin separately.
 */
export function assertArgvWithinPlatformLimit(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  if (
    platform === "win32" &&
    windowsCommandLineLength(command, args) + 1 > WINDOWS_COMMAND_LINE_MAX_UNITS
  ) {
    throw new RangeError(
      "claude CLI arguments exceed the Windows command-line limit; reduce `system_prompt` or `schema`",
    );
  }
}

// Variables that an attacker who controls the parent env could weaponize to
// alter API requests or inject shell behavior inside the child. Always dropped
// unless CLAUDECODE_MCP_FORWARD_DANGEROUS=1 is set.
const DANGEROUS_VARS = new Set([
  "CLAUDE_CODE_SHELL_PREFIX",
  "CLAUDE_CODE_EXTRA_BODY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_SCRIPT_CAPS",
  "CLAUDECODE",
]);

const ALLOWED_EXACT = new Set([
  // Standard shell / locale
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TZ",
  "TMPDIR",
  "LANG",
  // Windows process/runtime locations. These are harmless no-ops on POSIX,
  // but omitting them can break executable lookup, TLS, temp files, and the
  // default Claude config location on Windows.
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  // Anthropic auth (https://code.claude.com/docs/en/env-vars)
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  // Cloud-provider selection and auth. Keep this list explicit: in
  // particular, do not replace it with broad AWS_/AZURE_/GOOGLE_ prefixes.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "CLOUD_ML_REGION",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_AUTHORITY_HOST",
  // Routing
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  // Model selection
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "ANTHROPIC_BETAS",
  // TLS
  "CLAUDE_CODE_CERT_STORE",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  // Locations
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_DEBUG_LOGS_DIR",
]);

// `CLAUDECODE_MCP_` is our own namespace: forwarded so test stubs and any
// future child-readable knobs work without an explicit escape hatch.
const ALLOWED_PREFIXES = ["LC_", "XDG_", "VERTEX_REGION_CLAUDE_", "CLAUDECODE_MCP_"];

// PERF-004: Cache the filtered child env to avoid rebuilding it on every
// subprocess spawn. The cache key is an exact, deterministic snapshot rather
// than a lossy numeric hash: a hash collision must never preserve a stale
// security allowlist after process.env changes.
let _cachedChildEnv: { env: NodeJS.ProcessEnv; snapshot: string } | null = null;

/**
 * Serialize process.env without delimiter ambiguity. JSON-encoding sorted
 * key/value pairs gives exact equality while still making cache hits cheap
 * compared with spawning the CLI.
 */
function envSnapshot(): string {
  return JSON.stringify(
    Object.keys(process.env)
      .sort()
      .map((key) => [key, process.env[key]]),
  );
}

/**
 * Reset the child-env cache. Exported for test isolation so tests that
 * modify process.env between assertions can force a fresh build.
 */
export function resetEnvCache(): void {
  _cachedChildEnv = null;
}

function buildChildEnv(): NodeJS.ProcessEnv {
  // PERF-004: Return cached filtered env if process.env hasn't changed.
  const snapshot = envSnapshot();
  if (_cachedChildEnv && _cachedChildEnv.snapshot === snapshot) {
    return _cachedChildEnv.env;
  }
  const forwardDangerous = process.env.CLAUDECODE_MCP_FORWARD_DANGEROUS === "1";
  const extra = (process.env.CLAUDECODE_MCP_EXTRA_ENV ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const caseInsensitiveEnv = process.platform === "win32";
  const extraNormalized = new Set(
    extra.map((key) => (caseInsensitiveEnv ? key.toUpperCase() : key)),
  );
  // A null-prototype map prevents specially named environment keys from
  // mutating the object used as child_process.spawn's env option.
  const env: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  // OBS-009: Track env-filtering decisions for debuggability.
  let dangerousDropped = 0;
  let forwardedCount = 0;
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const dangerous = DANGEROUS_VARS.has(k.toUpperCase());
    if (!forwardDangerous && dangerous) {
      dangerousDropped++;
      continue;
    }
    const normalizedKey = caseInsensitiveEnv ? k.toUpperCase() : k;
    const allowed =
      (forwardDangerous && dangerous) ||
      ALLOWED_EXACT.has(normalizedKey) ||
      ALLOWED_PREFIXES.some((p) => normalizedKey.startsWith(p)) ||
      extraNormalized.has(normalizedKey);
    if (allowed) {
      env[k] = v;
      forwardedCount++;
    }
  }
  // OBS-009: Log env-filtering summary. Only emitted when DEBUG is enabled.
  debugLog({
    phase: "env_filter",
    forwarded: forwardedCount,
    dangerous_dropped: dangerousDropped,
    extra_env_keys: extra.length > 0 ? extra : undefined,
  });
  // Pin terminal-output behavior so the CLI doesn't emit colors or curses.
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  // PERF-004: Cache the built env with the exact current snapshot.
  _cachedChildEnv = { env, snapshot };
  return env;
}

/**
 * Spawn a CLI with an argv array (never shell-interpolated) and a curated env.
 * Stdin is closed immediately. Stdout/stderr are captured up to a byte cap;
 * the subprocess is killed if the timeout or cap is exceeded.
 */
export function invokeCli(
  command: string,
  args: string[],
  opts: InvokeOpts = {},
): Promise<InvokeResult> {
  const timeoutMs =
    opts.timeoutMs ?? numFromEnv("CLAUDECODE_MCP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, MAX_TIMER_MS);
  const maxOutputBytes =
    opts.maxOutputBytes ?? numFromEnv("CLAUDECODE_MCP_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES);

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    return Promise.reject(
      new RangeError(`timeoutMs must be a positive integer no greater than ${MAX_TIMER_MS}`),
    );
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new RangeError("maxOutputBytes must be a positive safe integer"));
  }
  if (opts.signal?.aborted) {
    return Promise.reject(new InvokeAbortedError());
  }
  try {
    assertArgvWithinPlatformLimit(command, args);
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    const start = Date.now();
    // A new process group lets timeout, output-cap, and cancellation cleanup
    // reach CLI descendants as well as the immediate child. Windows does not
    // support negative-PID process-group signaling, so it retains direct-child
    // behavior.
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: buildChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached,
    });
    debugLog({ phase: "spawn", command, argv_len: args.length, pid: child.pid });

    // PERF-001: Use array accumulation instead of string concatenation to
    // avoid O(n²) allocation pressure on large CLI outputs.
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    let bytes = 0;
    let settled = false;
    let terminationReason: "timeout" | "output_cap" | "cancelled" | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let requestTimer: NodeJS.Timeout | undefined;

    const onAbort = (): void => {
      beginTermination("cancelled");
    };

    const cleanup = (keepKillTimer = false): void => {
      clearTimeout(requestTimer);
      if (!keepKillTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (action: () => void, keepKillTimer = false): void => {
      if (settled) return;
      settled = true;
      cleanup(keepKillTimer);
      action();
    };

    const signalProcessTree = (signal: NodeJS.Signals): void => {
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (err) {
          // ESRCH means the complete group has already exited. For any other
          // error, fall back to signaling the immediate child.
          if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
        }
      }
      try {
        child.kill(signal);
      } catch {
        // process may already be dead
      }
    };

    const escalateKill = (): void => signalProcessTree("SIGKILL");

    const processGroupStillExists = (): boolean => {
      if (!detached || child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };

    function beginTermination(reason: "timeout" | "output_cap" | "cancelled"): void {
      if (terminationReason !== null) return;
      terminationReason = reason;
      signalProcessTree("SIGTERM");
      killTimer = setTimeout(escalateKill, KILL_GRACE_MS);
    }

    requestTimer = setTimeout(() => beginTermination("timeout"), timeoutMs);
    if (opts.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
      // Close the small race between the pre-spawn check and listener setup.
      if (opts.signal.aborted) onAbort();
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const onChunk = (chunk: string, target: "stdout" | "stderr"): void => {
      if (settled || terminationReason !== null) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > maxOutputBytes) {
        beginTermination("output_cap");
        // Reject promptly, but retain the escalation timer until the process
        // group closes in case a descendant ignores SIGTERM.
        finish(() => reject(new OutputTooLargeError(maxOutputBytes)), true);
        return;
      }
      if (target === "stdout") stdoutParts.push(chunk);
      else stderrParts.push(chunk);
    };

    child.stdout.on("data", (chunk: string) => onChunk(chunk, "stdout"));
    child.stderr.on("data", (chunk: string) => onChunk(chunk, "stderr"));

    child.on("error", (err) => {
      cleanup();
      if (settled) return;
      finish(() => {
        debugLog({
          phase: "exit",
          duration_ms: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
        reject(err);
      });
    });
    child.on("close", (code) => {
      const duration_ms = Date.now() - start;
      // The group leader may close while a descendant still ignores SIGTERM.
      // Retain escalation only when the POSIX process group still exists.
      const keepKillTimer = terminationReason !== null && processGroupStillExists();
      cleanup(keepKillTimer);
      if (terminationReason === "timeout") {
        debugLog({ phase: "exit", duration_ms, reason: "timeout", timeout_ms: timeoutMs });
        finish(() => reject(new InvokeTimeoutError(timeoutMs)), keepKillTimer);
        return;
      }
      if (terminationReason === "cancelled") {
        debugLog({ phase: "exit", duration_ms, reason: "cancelled" });
        finish(() => reject(new InvokeAbortedError()), keepKillTimer);
        return;
      }
      if (terminationReason === "output_cap") {
        debugLog({ phase: "exit", duration_ms, reason: "output_cap", bytes });
        // already rejected via onChunk; close is just cleanup
        return;
      }
      const stdout = stdoutParts.join("");
      const stderr = stderrParts.join("");
      // Record stderr size on non-zero exit without copying raw secrets into
      // debug logs. exitError emits a bounded, fully redacted preview later.
      if (code !== 0 && stderr) {
        debugLog({
          phase: "exit",
          duration_ms,
          exit_code: code,
          stdout_bytes: Buffer.byteLength(stdout, "utf8"),
          stderr_bytes: Buffer.byteLength(stderr, "utf8"),
        });
      } else {
        debugLog({
          phase: "exit",
          duration_ms,
          exit_code: code,
          stdout_bytes: Buffer.byteLength(stdout, "utf8"),
        });
      }
      finish(() => resolve({ stdout, stderr, exitCode: code, durationMs: duration_ms }));
    });

    // CORR-002/H1: Swallow stdin stream errors (EPIPE / write-after-end).
    // The child may exit or close its stdin before consuming the buffered
    // payload — with large stdin payloads (H1: prompts above the argv size
    // limit) the write only completes as the child drains the pipe, so an
    // early child exit surfaces as an `error` event here. Without a listener
    // that event would crash the process. The subprocess result is determined
    // by stdout/stderr/exitCode, not stdin delivery.
    child.stdin.on("error", (err) => {
      debugLog({ phase: "stdin_stream_error", error: err.message });
    });
    if (opts.stdin !== undefined && terminationReason === null) {
      child.stdin.write(opts.stdin, (err) => {
        // CORR-002: Ignore EPIPE / write-after-end errors. The child may
        // have already closed its stdin or exited; the subprocess result
        // is determined by stdout/stderr/exitCode, not stdin writes.
        if (err) {
          debugLog({ phase: "stdin_write_error", error: err.message });
        }
      });
    }
    child.stdin.end();
  });
}

/**
 * Defensively parse JSON from CLI stdout. Tries a direct parse, then bounded
 * standalone-line and balanced-bracket scans over the full buffer.
 * Claude-shaped payloads beat JSON-looking diagnostic lines; otherwise the
 * longest complete candidate wins. Throws if nothing parses.
 */
export function parseJsonLoose(raw: string): unknown {
  if (!/\S/.test(raw)) {
    throw new Error("empty stdout, no JSON to parse");
  }

  try {
    return JSON.parse(raw);
  } catch {
    // fall through
  }

  const parsedCandidates: Array<{
    value: unknown;
    length: number;
    index: number;
    claude: boolean;
  }> = [];
  const seenCandidates = new Set<string>();
  const considerCandidate = (slice: string, index: number): void => {
    const identity = `${index}:${slice.length}`;
    if (seenCandidates.has(identity)) return;
    seenCandidates.add(identity);
    try {
      const value: unknown = JSON.parse(slice);
      const claude =
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        ["result", "response", "structured_output"].some((key) =>
          Object.prototype.hasOwnProperty.call(value, key),
        );
      parsedCandidates.push({ value, length: slice.length, index, claude });
    } catch {
      /* ignore this candidate */
    }
  };

  // A malformed diagnostic with an unmatched opening bracket must not poison a
  // later standalone JSON response. Scan JSON-looking lines first without
  // split(), which would duplicate the entire (up to 50 MiB) output buffer.
  for (const candidate of jsonLineCandidates(raw)) {
    considerCandidate(candidate.slice, candidate.start);
  }

  // Balanced-bracket scan recovers pretty-printed or inline JSON regions.
  try {
    for (const candidate of balancedJsonCandidates(raw)) {
      considerCandidate(candidate.slice, candidate.start);
    }
  } catch (err) {
    // If a standalone response already parsed, adversarial unmatched noise
    // before it should not prevent recovery. Otherwise preserve the explicit
    // resource-bound error.
    if (parsedCandidates.length === 0) throw err;
  }
  parsedCandidates.sort(
    (a, b) =>
      Number(b.claude) - Number(a.claude) ||
      (a.claude && b.claude ? b.index - a.index : b.length - a.length) ||
      b.index - a.index,
  );
  if (parsedCandidates.length > 0) return parsedCandidates[0]!.value;

  // Do not splice a raw prefix into this error. A prefix can cut an arbitrary
  // explicitly-forwarded secret before the client-bound sanitizer sees it,
  // making exact-value redaction impossible.
  throw new Error("failed to parse JSON from CLI stdout");
}

/**
 * Redact known secret patterns from text (sk-ant-* tokens, Bearer headers,
 * AWS key patterns). This is a lightweight version for use in invoke.ts; the
 * full sanitizer (including env-var value redaction) lives in redaction.ts.
 */
export function redactBasicSecrets(text: string): string {
  let out = text;
  out = out.replace(/sk-ant-[A-Za-z0-9_\-]+/g, "sk-ant-***");
  out = out.replace(/\bBearer[ \t]+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer ***");
  // SEC-006: Extended cloud-provider key patterns
  out = out.replace(/\bAKIA[A-Z0-9]{16}\b/g, "***"); // AWS access key IDs
  out = out.replace(/\bASIA[A-Z0-9]{16}\b/g, "***"); // AWS temporary access key IDs
  return out;
}

const MAX_JSON_SCAN_DEPTH = 1024;
const MAX_JSON_CANDIDATES = 1000;

interface JsonCandidate {
  slice: string;
  start: number;
}

function jsonLineCandidates(s: string): JsonCandidate[] {
  const out: JsonCandidate[] = [];
  let lineStart = 0;
  while (lineStart <= s.length) {
    const newline = s.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? s.length : newline;
    let start = lineStart;
    let end = lineEnd;
    while (start < end && isJsonScanWhitespace(s.charCodeAt(start))) start++;
    while (end > start && isJsonScanWhitespace(s.charCodeAt(end - 1))) end--;
    const first = s[start];
    if (first === "{" || first === "[") {
      if (out.length >= MAX_JSON_CANDIDATES) {
        throw new Error(`JSON candidate count exceeds ${MAX_JSON_CANDIDATES}`);
      }
      out.push({ slice: s.slice(start, end), start });
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return out;
}

function isJsonScanWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0b || code === 0x0c;
}

function balancedJsonCandidates(s: string): JsonCandidate[] {
  const out: JsonCandidate[] = [];
  const stack: { ch: string; start: number }[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") {
      if (stack.length >= MAX_JSON_SCAN_DEPTH) {
        throw new Error(`JSON candidate nesting exceeds ${MAX_JSON_SCAN_DEPTH}`);
      }
      stack.push({ ch: c, start: i });
    } else if (c === "}" || c === "]") {
      const top = stack.pop();
      if (!top) continue;
      const expect = top.ch === "{" ? "}" : "]";
      if (c !== expect) {
        // Mismatched: discard the whole pending stack — this region isn't
        // structurally valid.
        stack.length = 0;
        continue;
      }
      if (stack.length === 0) {
        if (out.length >= MAX_JSON_CANDIDATES) {
          throw new Error(`JSON candidate count exceeds ${MAX_JSON_CANDIDATES}`);
        }
        out.push({ slice: s.slice(top.start, i + 1), start: top.start });
      }
    }
  }
  return out;
}
