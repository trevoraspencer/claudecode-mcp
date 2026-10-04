/**
 * Per-device bearer tokens for HTTP mode (DESIGN-v2 section 12.4).
 *
 * The tokens file holds only SHA-256 hashes, one named entry per client
 * device, so one device can be revoked without touching the others. The
 * file must be a private regular file (mode 0600, owned by the current
 * user, not a symlink) in a folder only its owner (or root) can change.
 * `claudecode-mcp token add|list|revoke` manages it under a lock file; the
 * HTTP server re-reads it on every request, so a revoke takes effect at once.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { errorLog } from "./log.js";
import { configPath } from "./paths.js";

export const TOKENS_FILE_NAME = "http-tokens.json";
export const TOKEN_PREFIX = "ccm_";
const MAX_TOKENS_FILE_BYTES = 1024 * 1024;
const MAX_TOKENS = 256;
/** `ccm_` + 43 base64url characters (32 random bytes). */
const TOKEN_RE = /^ccm_[A-Za-z0-9_-]{43}$/;
export const DEVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const entrySchema = z.strictObject({
  name: z.string().regex(DEVICE_NAME_RE),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: z.string().max(64),
});

const fileSchema = z
  .strictObject({
    version: z.literal(1),
    tokens: z.array(entrySchema).max(MAX_TOKENS),
  })
  .refine(
    (f) => new Set(f.tokens.map((t) => t.name)).size === f.tokens.length,
    "device names must be unique",
  );

export type TokenEntry = z.output<typeof entrySchema>;
type TokensFile = z.output<typeof fileSchema>;

export class TokenFileError extends Error {
  readonly code = "ETOKENS" as const;
  constructor(path: string, detail: string) {
    super(`invalid tokens file (${path}): ${detail}`);
    this.name = "TokenFileError";
  }
}

/** The tokens file: `http.tokens_file`, or `http-tokens.json` next to config.json. */
export function tokensFilePath(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  return config.http.tokens_file ?? join(dirname(configPath(env)), TOKENS_FILE_NAME);
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The folder must not let anyone else swap the file: owned by the current
 * user or root, and not group/world writable (unless sticky, like /tmp).
 */
function checkParent(path: string): void {
  const dir = dirname(path);
  let st;
  try {
    st = statSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new TokenFileError(path, `cannot read its folder: ${(err as Error).message}`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
  if (st.uid !== uid && st.uid !== 0) {
    throw new TokenFileError(path, "its folder is owned by another user");
  }
  if ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0) {
    throw new TokenFileError(path, "its folder is writable by other users");
  }
}

/**
 * Read and check the tokens file. A missing file is an empty list. Anything
 * else that is wrong (symlink, other owner, group/world access, unsafe
 * folder, bad JSON) is an error: a token file others can read or replace is
 * not a secret. The checks and the read use one no-follow file descriptor,
 * so the file cannot be swapped between them. Returns the raw bytes too, so
 * callers can tell whether the content changed.
 */
export function readTokensFile(path: string): { tokens: TokenEntry[]; raw: Buffer } {
  checkParent(path);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { tokens: [], raw: Buffer.alloc(0) };
    if (code === "ELOOP") throw new TokenFileError(path, "is a symlink");
    throw new TokenFileError(path, `cannot read: ${(err as Error).message}`);
  }
  let raw: Buffer;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new TokenFileError(path, "not a regular file");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new TokenFileError(path, "owned by another user");
    }
    if ((st.mode & 0o077) !== 0) {
      throw new TokenFileError(path, `mode ${(st.mode & 0o777).toString(8)} is too open; use 0600`);
    }
    if (st.size > MAX_TOKENS_FILE_BYTES) {
      throw new TokenFileError(path, `larger than ${MAX_TOKENS_FILE_BYTES} bytes`);
    }
    const buf = Buffer.alloc(MAX_TOKENS_FILE_BYTES + 1);
    let size = 0;
    for (;;) {
      const n = readSync(fd, buf, size, buf.length - size, null);
      if (n === 0) break;
      size += n;
      if (size > MAX_TOKENS_FILE_BYTES) {
        throw new TokenFileError(path, `larger than ${MAX_TOKENS_FILE_BYTES} bytes`);
      }
    }
    raw = buf.subarray(0, size);
  } finally {
    closeSync(fd);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throw new TokenFileError(path, `not valid JSON: ${(err as Error).message}`);
  }
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) throw new TokenFileError(path, z.prettifyError(parsed.error));
  return { tokens: parsed.data.tokens, raw };
}

export function readTokens(path: string): TokenEntry[] {
  return readTokensFile(path).tokens;
}

const LOCK_WAIT_MS = 5_000;

/**
 * Run a read-modify-write of the tokens file under `<file>.lock`, so two
 * token commands at once cannot undo each other (a lost revoke).
 */
function withTokensLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + ".lock";
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() >= deadline) {
        throw new Error(
          `tokens file is locked by another token command (${lock}); remove the lock if it is stale`,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

/** Atomic write with mode 0600; the parent folder is created with 0700. */
function writeTokens(path: string, tokens: TokenEntry[]): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body: TokensFile = { version: 1, tokens };
  const tmp = join(dir, `.${TOKENS_FILE_NAME}.${process.pid}.${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(body, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Create a token for `name`. Returns the token; it is shown once and never stored. */
export function addToken(path: string, name: string): string {
  if (!DEVICE_NAME_RE.test(name)) {
    throw new Error(`device name must match ${DEVICE_NAME_RE.source}`);
  }
  return withTokensLock(path, () => addTokenLocked(path, name));
}

function addTokenLocked(path: string, name: string): string {
  const tokens = readTokens(path);
  if (tokens.some((t) => t.name === name)) {
    throw new Error(`a token named "${name}" already exists; revoke it first`);
  }
  if (tokens.length >= MAX_TOKENS) throw new Error(`at most ${MAX_TOKENS} tokens`);
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  tokens.push({
    name,
    sha256: sha256(token).toString("hex"),
    created_at: new Date().toISOString(),
  });
  writeTokens(path, tokens);
  return token;
}

/** Remove the token for `name`. */
export function revokeToken(path: string, name: string): void {
  withTokensLock(path, () => {
    const tokens = readTokens(path);
    const kept = tokens.filter((t) => t.name !== name);
    if (kept.length === tokens.length) throw new Error(`no token named "${name}"`);
    writeTokens(path, kept);
  });
}

/**
 * Find the device for a presented token. Compares the SHA-256 of the token
 * against every entry in constant time and never stops early, so timing does
 * not reveal which entry (if any) matched.
 */
export function matchToken(tokens: readonly TokenEntry[], presented: string): string | undefined {
  if (!TOKEN_RE.test(presented)) return undefined;
  const digest = sha256(presented);
  let found: string | undefined;
  for (const t of tokens) {
    if (timingSafeEqual(Buffer.from(t.sha256, "hex"), digest) && found === undefined) {
      found = t.name;
    }
  }
  return found;
}

/**
 * The server's view of the tokens file. Re-reads the file on every lookup
 * (it is small) and re-parses only when its bytes changed, so no edit can go
 * unnoticed. If a read fails, no token is accepted until the file is fixed
 * (fail closed).
 */
export class TokenStore {
  private tokens: TokenEntry[] = [];
  private digest = "";
  private lastError = "";

  constructor(readonly path: string) {}

  /** Load at startup. Throws if the file is invalid or holds no tokens. */
  load(): number {
    const { tokens, raw } = readTokensFile(this.path);
    if (tokens.length === 0) {
      throw new TokenFileError(
        this.path,
        "no tokens; create one with `claudecode-mcp token add <device-name>`",
      );
    }
    this.tokens = tokens;
    this.digest = sha256Hex(raw);
    return tokens.length;
  }

  private refresh(): void {
    try {
      const { tokens, raw } = readTokensFile(this.path);
      const digest = sha256Hex(raw);
      if (digest !== this.digest) {
        this.tokens = tokens;
        this.digest = digest;
      }
      this.lastError = "";
    } catch (err) {
      this.tokens = [];
      this.digest = "";
      const message = (err as Error).message;
      if (message !== this.lastError) errorLog({ phase: "http_tokens", error: message });
      this.lastError = message;
    }
  }

  /** The device name for a presented token, or undefined. */
  lookup(presented: string): string | undefined {
    this.refresh();
    return matchToken(this.tokens, presented);
  }
}
