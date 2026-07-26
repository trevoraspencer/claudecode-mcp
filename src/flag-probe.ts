/**
 * CLI `--json-schema` flag probe with time-based caching.
 *
 * ARCH-003: The flag cache is encapsulated in this module with an explicit
 * `resetFlagCache()` export for test isolation. The cache is keyed on the
 * resolved binary path and auto-expires after 5 minutes.
 */

import { invokeCli, debugLog, InvokeAbortedError } from "./invoke.js";

const HELP_PROBE_TIMEOUT_MS = 5000;
const HELP_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;
const FLAG_PROBE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve the claude binary path from the environment or default.
 */
export function getClaudeBin(): string {
  return process.env.CLAUDECODE_MCP_CLAUDE_BIN ?? "claude";
}

interface FlagCacheEntry {
  bin: string;
  available: boolean;
  expiresAt: number;
}

let flagCache: FlagCacheEntry | undefined;
// L1: The in-flight probe is keyed by binary path (like the cache) so a
// CLAUDECODE_MCP_CLAUDE_BIN change mid-probe cannot hand callers the old
// binary's answer.
interface FlagInflightEntry {
  bin: string;
  promise: Promise<boolean>;
  controller: AbortController;
  waiters: number;
  done: boolean;
  generation: number;
}

let flagInflight: FlagInflightEntry | undefined;
let flagCacheGeneration = 0;

/**
 * Reset the flag-probe cache. For use in tests to ensure clean state
 * between test cases when the claude binary path changes.
 */
export function resetFlagCache(): void {
  flagCacheGeneration++;
  flagCache = undefined;
  flagInflight?.controller.abort();
  flagInflight = undefined;
  debugLog({ phase: "flag_cache_reset" });
}

/**
 * Wait for a shared probe without letting one cancelled request abort work
 * still needed by another request. Once every waiter has gone away, abort the
 * underlying `claude --help` subprocess as well.
 */
function waitForProbe(entry: FlagInflightEntry, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(new InvokeAbortedError());
  entry.waiters++;

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;

    const release = (): void => {
      entry.waiters--;
      if (entry.waiters === 0 && !entry.done) {
        entry.controller.abort();
      }
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      release();
      action();
    };
    const onAbort = (): void => {
      finish(() => reject(new InvokeAbortedError()));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    // Close the race between the initial check and listener registration.
    if (signal?.aborted) {
      onAbort();
      return;
    }
    entry.promise.then(
      (available) => finish(() => resolve(available)),
      (err) => finish(() => reject(err)),
    );
  });
}

/**
 * Probe whether the installed `claude` CLI supports the `--json-schema` flag.
 * Results are cached for FLAG_PROBE_TTL_MS (5 minutes), keyed on the
 * resolved binary path.
 *
 * OBS-005: Cache hit/miss/failure is logged via debugLog when debug mode
 * is enabled.
 */
export async function isJsonSchemaFlagAvailable(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new InvokeAbortedError();
  const bin = getClaudeBin();
  const now = Date.now();
  if (flagCache && flagCache.bin === bin && flagCache.expiresAt > now) {
    debugLog({ phase: "flag_cache_hit", bin, available: flagCache.available });
    return flagCache.available;
  }
  if (
    flagInflight &&
    flagInflight.bin === bin &&
    !flagInflight.done &&
    !flagInflight.controller.signal.aborted
  ) {
    return waitForProbe(flagInflight, signal);
  }
  debugLog({ phase: "flag_cache_miss", bin });
  const controller = new AbortController();
  const entry: FlagInflightEntry = {
    bin,
    promise: Promise.resolve(false),
    controller,
    waiters: 0,
    done: false,
    generation: flagCacheGeneration,
  };
  entry.promise = (async () => {
    try {
      const result = await invokeCli(bin, ["--help"], {
        cwd: process.cwd(),
        timeoutMs: HELP_PROBE_TIMEOUT_MS,
        maxOutputBytes: HELP_PROBE_MAX_OUTPUT_BYTES,
        signal: controller.signal,
      });
      const help = `${result.stdout}\n${result.stderr}`;
      const available = /--json-schema\b/.test(help);
      if (entry.generation === flagCacheGeneration && flagInflight === entry) {
        flagCache = { bin, available, expiresAt: Date.now() + FLAG_PROBE_TTL_MS };
      }
      debugLog({ phase: "flag_cache_stored", bin, available });
      return available;
    } catch (err) {
      if (err instanceof InvokeAbortedError && controller.signal.aborted) {
        debugLog({ phase: "flag_cache_aborted", bin });
        return false;
      }
      debugLog({
        phase: "flag_cache_error",
        bin,
        error: err instanceof Error ? err.message : String(err),
      });
      if (entry.generation === flagCacheGeneration && flagInflight === entry) {
        flagCache = { bin, available: false, expiresAt: Date.now() + FLAG_PROBE_TTL_MS };
      }
      return false;
    } finally {
      entry.done = true;
      // Only clear our own entry — a newer probe for a different binary may
      // have replaced it while this one was still running.
      if (flagInflight === entry) {
        flagInflight = undefined;
      }
    }
  })();
  flagInflight = entry;
  return waitForProbe(entry, signal);
}
