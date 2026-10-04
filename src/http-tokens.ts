/**
 * Per-device bearer tokens for HTTP mode (DESIGN-v2 section 12.4).
 *
 * The tokens file holds only SHA-256 hashes, one named entry per client
 * device, so one device can be revoked without touching the others. The
 * file must be a private regular file (mode 0600, owned by the current
 * user). `claudecode-mcp token add|list|revoke` manages it; the HTTP server
 * re-reads it when it changes, so a revoke takes effect without a restart.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
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

/**
 * Read and check the tokens file. A missing file is an empty list. Anything
 * else that is wrong (symlink, other owner, group/world access, bad JSON) is
 * an error: a token file others can read or replace is not a secret.
 */
export function readTokens(path: string): TokenEntry[] {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new TokenFileError(path, `cannot read: ${(err as Error).message}`);
  }
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
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new TokenFileError(path, `not valid JSON: ${(err as Error).message}`);
  }
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) throw new TokenFileError(path, z.prettifyError(parsed.error));
  return parsed.data.tokens;
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
  const tokens = readTokens(path);
  const kept = tokens.filter((t) => t.name !== name);
  if (kept.length === tokens.length) throw new Error(`no token named "${name}"`);
  writeTokens(path, kept);
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
 * The server's view of the tokens file. Checks the file's identity on each
 * lookup and reloads when it changed. If a reload fails, no token is accepted
 * until the file is fixed (fail closed).
 */
export class TokenStore {
  private tokens: TokenEntry[] = [];
  private stamp = "";

  constructor(readonly path: string) {}

  /** Load at startup. Throws if the file is invalid or holds no tokens. */
  load(): number {
    this.tokens = readTokens(this.path);
    this.stamp = this.currentStamp();
    if (this.tokens.length === 0) {
      throw new TokenFileError(
        this.path,
        "no tokens; create one with `claudecode-mcp token add <device-name>`",
      );
    }
    return this.tokens.length;
  }

  private currentStamp(): string {
    try {
      const st = lstatSync(this.path);
      return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}:${st.uid}`;
    } catch {
      return "missing";
    }
  }

  private refresh(): void {
    const stamp = this.currentStamp();
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    try {
      this.tokens = readTokens(this.path);
    } catch (err) {
      this.tokens = [];
      errorLog({ phase: "http_tokens", error: (err as Error).message });
    }
  }

  /** The device name for a presented token, or undefined. */
  lookup(presented: string): string | undefined {
    this.refresh();
    return matchToken(this.tokens, presented);
  }
}
