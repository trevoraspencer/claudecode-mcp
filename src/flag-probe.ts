/**
 * CLI `--json-schema` flag probe with time-based caching.
 *
 * ARCH-003: The flag cache is encapsulated in this module with an explicit
 * `resetFlagCache()` export for test isolation. The cache is keyed on the
 * resolved binary path and auto-expires after 5 minutes.
 */

import { invokeCli, debugLog } from "./invoke.js";

const HELP_PROBE_TIMEOUT_MS = 5000;
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
let flagInflight: Promise<boolean> | undefined;

/**
 * Reset the flag-probe cache. For use in tests to ensure clean state
 * between test cases when the claude binary path changes.
 */
export function resetFlagCache(): void {
  flagCache = undefined;
  flagInflight = undefined;
  debugLog({ phase: "flag_cache_reset" });
}

/**
 * Probe whether the installed `claude` CLI supports the `--json-schema` flag.
 * Results are cached for FLAG_PROBE_TTL_MS (5 minutes), keyed on the
 * resolved binary path.
 *
 * OBS-005: Cache hit/miss/failure is logged via debugLog when debug mode
 * is enabled.
 */
export async function isJsonSchemaFlagAvailable(): Promise<boolean> {
  const bin = getClaudeBin();
  const now = Date.now();
  if (flagCache && flagCache.bin === bin && flagCache.expiresAt > now) {
    debugLog({ phase: "flag_cache_hit", bin, available: flagCache.available });
    return flagCache.available;
  }
  if (flagInflight) return flagInflight;
  debugLog({ phase: "flag_cache_miss", bin });
  flagInflight = (async () => {
    try {
      const result = await invokeCli(bin, ["--help"], {
        cwd: process.cwd(),
        timeoutMs: HELP_PROBE_TIMEOUT_MS,
      });
      const help = `${result.stdout}\n${result.stderr}`;
      const available = /--json-schema\b/.test(help);
      flagCache = { bin, available, expiresAt: Date.now() + FLAG_PROBE_TTL_MS };
      debugLog({ phase: "flag_cache_stored", bin, available });
      return available;
    } catch (err) {
      debugLog({
        phase: "flag_cache_error",
        bin,
        error: err instanceof Error ? err.message : String(err),
      });
      flagCache = { bin, available: false, expiresAt: Date.now() + FLAG_PROBE_TTL_MS };
      return false;
    } finally {
      flagInflight = undefined;
    }
  })();
  return flagInflight;
}
