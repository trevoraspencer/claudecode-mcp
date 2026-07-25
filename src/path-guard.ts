import { realpath, stat, open } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { numFromEnv } from "./env.js";

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export class PathGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathGuardError";
  }
}

/**
 * Shared phase 1 (L8): resolve a user-supplied relative path strictly under
 * cwd and enforce symlink containment. Rejects absolute paths, ../ escapes,
 * and symlinks that resolve outside cwd; maps ENOENT to a friendly error.
 * Returns the realpath of the target for the caller's phase-2 checks.
 *
 * PERF-003: Accepts an optional pre-computed `baseReal` (realpath of cwd) so
 * callers that resolve multiple files per request can avoid redundant
 * realpath() syscalls. When omitted, realpath(cwd) is computed per call.
 */
async function resolveRealUnderCwd(input: string, cwd: string, baseReal?: string): Promise<string> {
  if (isAbsolute(input)) {
    throw new PathGuardError(`path must be relative: ${input}`);
  }
  const resolvedBase = baseReal ?? (await realpath(cwd));
  const resolved = resolve(resolvedBase, input);
  const prefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (resolved !== resolvedBase && !resolved.startsWith(prefix)) {
    throw new PathGuardError(`path escapes working directory: ${input}`);
  }
  let real: string;
  try {
    real = await realpath(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new PathGuardError(`file not found: ${input}`);
    }
    throw err;
  }
  if (real !== resolvedBase && !real.startsWith(prefix)) {
    throw new PathGuardError(`path resolves outside working directory via symlink: ${input}`);
  }
  return real;
}

/**
 * Resolve a user-supplied relative path strictly under cwd. Rejects absolute
 * paths, ../ escapes, and symlinks that resolve outside cwd. Also enforces a
 * per-file size cap before the caller reads it.
 *
 * PERF-003: Accepts an optional pre-computed `baseReal` (realpath of cwd) so
 * callers that resolve multiple files per request can avoid redundant
 * realpath() syscalls. When omitted, realpath(cwd) is computed per call.
 */
export async function safeResolveUnderCwd(
  input: string,
  cwd: string = process.cwd(),
  baseReal?: string,
): Promise<string> {
  const real = await resolveRealUnderCwd(input, cwd, baseReal);
  const info = await stat(real);
  if (!info.isFile()) {
    throw new PathGuardError(`not a regular file: ${input}`);
  }
  const cap = numFromEnv("CLAUDECODE_MCP_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES);
  if (info.size > cap) {
    throw new PathGuardError(`file exceeds ${cap} bytes (${info.size}): ${input}`);
  }
  return real;
}

/**
 * Resolve, validate, and atomically read a file under cwd. Opens the file by
 * fd after path/symlink validation, then fstat + read on the same fd,
 * eliminating the TOCTOU race between stat() and readFile() that would exist
 * if the caller used safeResolveUnderCwd() + readFile() separately.
 *
 * SEC-004: The fd-based approach ensures the file metadata checked by fstat()
 * corresponds to the same inode read by readFile(), closing the window where
 * an attacker with local filesystem access could swap the file between
 * validation and read.
 *
 * PERF-003: Accepts an optional pre-computed `baseReal` (realpath of cwd) so
 * callers that resolve multiple files per request can avoid redundant
 * realpath() syscalls. When omitted, realpath(cwd) is computed per call.
 */
export async function safeReadFileUnderCwd(
  input: string,
  cwd: string = process.cwd(),
  baseReal?: string,
): Promise<string> {
  // Phase 1: Path resolution and symlink containment (shared with
  // safeResolveUnderCwd via resolveRealUnderCwd).
  const real = await resolveRealUnderCwd(input, cwd, baseReal);

  // Phase 2: Open fd, validate via fstat, and read atomically.
  const fh = await open(real, "r");
  try {
    const info = await fh.stat();
    if (!info.isFile()) {
      throw new PathGuardError(`not a regular file: ${input}`);
    }
    const cap = numFromEnv("CLAUDECODE_MCP_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES);
    if (info.size > cap) {
      throw new PathGuardError(`file exceeds ${cap} bytes (${info.size}): ${input}`);
    }
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}
