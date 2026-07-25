/**
 * Shared environment-variable utilities used across modules.
 */

/**
 * Parse a positive finite number from an environment variable, returning
 * the fallback if the variable is absent, empty, or non-finite/non-positive.
 */
export function numFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
