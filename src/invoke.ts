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

// Defaults are intentionally generous; the env vars exist so operators can
// tighten them without code changes.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

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
  // Anthropic auth (https://code.claude.com/docs/en/env-vars)
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  // Cloud provider auth
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  // Routing
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  // Model selection
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
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
const ALLOWED_PREFIXES = ["LC_", "XDG_", "CLAUDECODE_MCP_"];

// PERF-004: Cache the filtered child env to avoid re-iterating process.env
// on every subprocess spawn. The cache is invalidated when the env fingerprint
// changes, which detects any mutation to process.env between calls.
let _cachedChildEnv: { env: NodeJS.ProcessEnv; fingerprint: number } | null = null;

/**
 * Compute a lightweight numeric fingerprint of process.env for cache
 * invalidation. Uses a polynomial rolling hash over sorted key-value pairs.
 * Collisions are possible but extremely unlikely for typical env sizes
 * (tens of entries). The cost of this hash is a simple integer-multiply
 * per character, which is significantly cheaper than building the filtered
 * env object with string key comparisons and property assignments.
 */
function envFingerprint(): number {
  let h = 0x811c9dc5;
  const keys = Object.keys(process.env).sort();
  for (const k of keys) {
    for (let i = 0; i < k.length; i++) {
      h ^= k.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193);
    const v = process.env[k];
    if (v !== undefined) {
      for (let i = 0; i < v.length; i++) {
        h ^= v.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
    }
  }
  return h;
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
  const fp = envFingerprint();
  if (_cachedChildEnv && _cachedChildEnv.fingerprint === fp) {
    return _cachedChildEnv.env;
  }
  const forwardDangerous = process.env.CLAUDECODE_MCP_FORWARD_DANGEROUS === "1";
  const extra = (process.env.CLAUDECODE_MCP_EXTRA_ENV ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const env: NodeJS.ProcessEnv = {};
  // OBS-009: Track env-filtering decisions for debuggability.
  let dangerousDropped = 0;
  let forwardedCount = 0;
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (!forwardDangerous && DANGEROUS_VARS.has(k)) {
      dangerousDropped++;
      continue;
    }
    const allowed =
      ALLOWED_EXACT.has(k) || ALLOWED_PREFIXES.some((p) => k.startsWith(p)) || extra.includes(k);
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
  // PERF-004: Cache the built env with the current fingerprint.
  _cachedChildEnv = { env, fingerprint: fp };
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
  const timeoutMs = opts.timeoutMs ?? numFromEnv("CLAUDECODE_MCP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const maxOutputBytes =
    opts.maxOutputBytes ?? numFromEnv("CLAUDECODE_MCP_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES);

  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(command, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: buildChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    debugLog({ phase: "spawn", command, argv_len: args.length, pid: child.pid });

    // PERF-001: Use array accumulation instead of string concatenation to
    // avoid O(n²) allocation pressure on large CLI outputs.
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let exceeded = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      action();
    };

    /**
     * Settle the promise without cancelling the SIGKILL escalation timer.
     * Used when SIGTERM has been sent but we want the grace-period
     * escalation to proceed even though the promise is already rejected.
     */
    const settleWithoutCancellingKill = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Intentionally NOT clearing killTimer so SIGKILL escalation can
      // proceed if the child ignores SIGTERM.
      action();
    };

    const escalateKill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // process may already be dead
      }
    };

    let killTimer: NodeJS.Timeout = setTimeout(() => undefined, 0);
    clearTimeout(killTimer);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      killTimer = setTimeout(escalateKill, KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const onChunk = (chunk: string, target: "stdout" | "stderr"): void => {
      if (settled || exceeded) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > maxOutputBytes) {
        exceeded = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        killTimer = setTimeout(escalateKill, KILL_GRACE_MS);
        // CORR-001: Use settleWithoutCancellingKill so the SIGKILL escalation
        // timer is not cancelled when we settle the promise. The child may
        // ignore SIGTERM; SIGKILL after KILL_GRACE_MS ensures cleanup.
        settleWithoutCancellingKill(() => reject(new OutputTooLargeError(maxOutputBytes)));
        return;
      }
      if (target === "stdout") stdoutParts.push(chunk);
      else stderrParts.push(chunk);
    };

    child.stdout.on("data", (chunk: string) => onChunk(chunk, "stdout"));
    child.stderr.on("data", (chunk: string) => onChunk(chunk, "stderr"));

    child.on("error", (err) =>
      finish(() => {
        debugLog({
          phase: "exit",
          duration_ms: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
        reject(err);
      }),
    );
    child.on("close", (code) => {
      const duration_ms = Date.now() - start;
      if (timedOut) {
        debugLog({ phase: "exit", duration_ms, reason: "timeout", timeout_ms: timeoutMs });
        finish(() => reject(new InvokeTimeoutError(timeoutMs)));
        return;
      }
      if (exceeded) {
        debugLog({ phase: "exit", duration_ms, reason: "output_cap", bytes });
        // already rejected via onChunk; close is just cleanup
        return;
      }
      const stdout = stdoutParts.join("");
      const stderr = stderrParts.join("");
      // OBS-003: Log stderr content on non-zero exit for diagnosability.
      // Only log via debugLog (structured, gated by DEBUG=claudecode-mcp)
      // to avoid always-on noise.
      if (code !== 0 && stderr) {
        debugLog({
          phase: "exit",
          duration_ms,
          exit_code: code,
          stdout_bytes: stdout.length,
          stderr_snippet: stderr.slice(0, 500),
        });
      } else {
        debugLog({ phase: "exit", duration_ms, exit_code: code, stdout_bytes: stdout.length });
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
    if (opts.stdin !== undefined) {
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
 * Defensively parse JSON from CLI stdout. Tries: direct parse, line-by-line
 * scan for JSON-looking lines, and a balanced-bracket scan over the full
 * buffer. Throws if nothing parses.
 */
export function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("empty stdout, no JSON to parse");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith("{") || l.startsWith("[")) {
      try {
        return JSON.parse(l);
      } catch {
        /* continue */
      }
    }
  }

  // Balanced-bracket scan: find each region whose brackets nest cleanly and
  // try to parse it. Picking the longest match favors the full payload over
  // a smaller embedded one.
  const candidates = balancedJsonCandidates(trimmed);
  candidates.sort((a, b) => b.length - a.length);
  for (const slice of candidates) {
    try {
      return JSON.parse(slice);
    } catch {
      /* continue */
    }
  }

  throw new Error(
    `failed to parse JSON from CLI stdout: ${redactBasicSecrets(trimmed.slice(0, 200))}`,
  );
}

/**
 * Redact known secret patterns from text (sk-ant-* tokens, Bearer headers,
 * AWS key patterns). This is a lightweight version for use in invoke.ts; the
 * full sanitizer (including env-var value redaction) lives in redaction.ts.
 */
export function redactBasicSecrets(text: string): string {
  let out = text;
  out = out.replace(/sk-ant-[A-Za-z0-9_\-]+/g, "sk-ant-***");
  out = out.replace(/Bearer\s+[A-Za-z0-9_\-.=]+/g, "Bearer ***");
  // SEC-006: Extended cloud-provider key patterns
  out = out.replace(/\bAKIA[A-Z0-9]{16}\b/g, "***"); // AWS access key IDs
  out = out.replace(/\bASIA[A-Z0-9]{16}\b/g, "***"); // AWS temporary access key IDs
  return out;
}

function balancedJsonCandidates(s: string): string[] {
  const out: string[] = [];
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
        out.push(s.slice(top.start, i + 1));
      }
    }
  }
  return out;
}
