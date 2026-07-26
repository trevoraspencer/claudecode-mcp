/**
 * Shared environment-variable utilities used across modules.
 */

/**
 * Parse a positive, bounded integer from an environment variable. Resource
 * limits and timer durations must not accept fractions, unsafe integers, or
 * values above Node's supported range (large setTimeout values are otherwise
 * silently clamped to 1 ms).
 */
export function numFromEnv(
  key: string,
  fallback: number,
  max: number = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n <= max ? n : fallback;
}
