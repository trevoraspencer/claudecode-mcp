import { constants, type Stats } from "node:fs";
import { realpath, stat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { numFromEnv } from "./env.js";

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

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
function assertContained(real: string, resolvedBase: string, input: string): void {
  const prefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (real !== resolvedBase && !real.startsWith(prefix)) {
    throw new PathGuardError(`path resolves outside working directory via symlink: ${input}`);
  }
}

async function resolveRealUnderCwd(
  input: string,
  cwd: string,
  baseReal?: string,
): Promise<{ real: string; resolvedBase: string }> {
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
  assertContained(real, resolvedBase, input);
  return { real, resolvedBase };
}

async function assertPathStillMatchesOpenedFile(
  real: string,
  resolvedBase: string,
  input: string,
  openedInfo: Stats,
): Promise<void> {
  // Re-resolve the path after open so a swapped parent directory/junction
  // cannot silently redirect it outside cwd on platforms without procfs.
  const currentReal = await realpath(real);
  assertContained(currentReal, resolvedBase, input);
  const pathInfo = await stat(real);
  if (pathInfo.dev !== openedInfo.dev || pathInfo.ino !== openedInfo.ino) {
    throw new PathGuardError(`path changed while it was being opened: ${input}`);
  }
}

async function readFileCapped(fh: FileHandle, cap: number, input: string): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (bytes <= cap) {
    // Read one byte beyond the cap so a file that grows after fstat is rejected
    // rather than silently truncated or allocated without bound.
    const requested = Math.min(READ_CHUNK_BYTES, cap - bytes + 1);
    const buffer = Buffer.allocUnsafe(requested);
    const { bytesRead } = await fh.read(buffer, 0, requested, bytes);
    if (bytesRead === 0) break;
    bytes += bytesRead;
    if (bytes > cap) {
      throw new PathGuardError(`file exceeds ${cap} bytes while being read: ${input}`);
    }
    chunks.push(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
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
  const { real } = await resolveRealUnderCwd(input, cwd, baseReal);
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
 * fd after path/symlink validation, then fstat + read on the same fd. POSIX
 * rejects a swapped final symlink; Linux verifies the opened descriptor's
 * canonical target through procfs, while other platforms re-check canonical
 * containment and inode identity after open.
 *
 * SEC-004: The fd-based approach ensures the metadata checked by fstat()
 * corresponds to the same inode read by readFile(), rather than validating
 * one inode and reopening another for the actual read.
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
  const { real, resolvedBase } = await resolveRealUnderCwd(input, cwd, baseReal);

  // Phase 2: Open fd, validate via fstat, and read atomically.
  // O_NOFOLLOW rejects a final-component symlink introduced after realpath().
  // Platform-specific post-open checks below also cover swapped parent
  // components.
  const openFlags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const fh = await open(real, openFlags);
  try {
    const info = await fh.stat();
    if (!info.isFile()) {
      throw new PathGuardError(`not a regular file: ${input}`);
    }
    if (process.platform === "linux") {
      try {
        const openedReal = await realpath(`/proc/self/fd/${fh.fd}`);
        assertContained(openedReal, resolvedBase, input);
      } catch (err) {
        // Some constrained Linux environments do not mount procfs. Fail over
        // to portable post-open containment + inode checks instead of making
        // all context reads unusable.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
        await assertPathStillMatchesOpenedFile(real, resolvedBase, input, info);
      }
    } else {
      await assertPathStillMatchesOpenedFile(real, resolvedBase, input, info);
    }
    const cap = numFromEnv("CLAUDECODE_MCP_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES);
    if (info.size > cap) {
      throw new PathGuardError(`file exceeds ${cap} bytes (${info.size}): ${input}`);
    }
    return await readFileCapped(fh, cap, input);
  } finally {
    await fh.close();
  }
}
