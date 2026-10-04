/**
 * Repo URLs for `repo_url` tasks (DESIGN-v2 section 12.5): parsing,
 * normalization, and allowlist matching. Pure functions, no I/O.
 *
 * Accepted forms: `https://host/a/b[.git]`, `ssh://[user@]host[:port]/a/b`,
 * and scp-like `user@host:a/b`. All normalize to one canonical string, so a
 * pattern and a URL compare the same way. Everything else is refused:
 * other schemes (`ext::`, `http://`, `git://`; `file://` only when the
 * caller allows it, for tests), credentials, query or fragment, percent
 * escapes, option-like values, and `.`/`..` segments.
 */

export class RepoUrlError extends Error {
  readonly code = "EREPOURL" as const;
  constructor(message: string) {
    super(message);
    this.name = "RepoUrlError";
  }
}

export interface RepoUrl {
  scheme: "https" | "ssh" | "file";
  user?: string;
  host: string;
  port?: string;
  /** Path segments, without a trailing `.git` on the last one (kept for file://). */
  segments: string[];
  /** The normalized form used for matching and display (no `.git`). */
  canonical: string;
  /** What `git clone` gets: the canonical form, plus `.git` if it was given. */
  cloneUrl: string;
}

const MAX_URL = 2048;
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PATTERN_SEGMENT_RE = /^[A-Za-z0-9._*-]{1,100}$/;
const SCP_RE = /^([A-Za-z0-9._-]{1,64})@([A-Za-z0-9.-]{1,253}):([^/].*)$/;

function bad(raw: string, why: string): never {
  throw new RepoUrlError(`invalid repo_url (${why}): ${raw.slice(0, 200)}`);
}

/**
 * Parse and normalize. `pattern` allows `*` inside path segments (for
 * `repo_urls`); `allowFile` allows `file://` (tests only).
 */
export function parseRepoUrl(
  raw: string,
  opts: { pattern?: boolean; allowFile?: boolean } = {},
): RepoUrl {
  if (typeof raw !== "string" || raw.length === 0) bad(String(raw), "empty");
  if (raw.length > MAX_URL) bad(raw, "too long");
  if (/[\s\u0000-\u001f\u007f\\]/.test(raw))
    bad(raw, "whitespace, control character, or backslash");
  if (raw.startsWith("-")) bad(raw, "looks like an option");
  if (raw.includes("::")) bad(raw, "transport syntax such as ext:: is not allowed");
  if (raw.includes("%")) bad(raw, "percent escapes are not allowed");
  // URL parsing would quietly resolve these; refuse them as written.
  if (raw.split(/[/:]/).some((seg) => seg === "." || seg === "..")) {
    bad(raw, ". or .. path segments");
  }

  let scheme: RepoUrl["scheme"];
  let user: string | undefined;
  let host: string;
  let port: string | undefined;
  let path: string;

  const scp = raw.includes("://") ? null : SCP_RE.exec(raw);
  if (scp) {
    scheme = "ssh";
    user = scp[1];
    host = scp[2]!.toLowerCase();
    path = scp[3]!;
  } else {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      bad(raw, "not a URL");
    }
    const proto = u.protocol.slice(0, -1);
    if (proto === "file") {
      if (!opts.allowFile) bad(raw, "file:// URLs are not allowed");
      if (u.host !== "") bad(raw, "file:// URLs need an empty host");
      scheme = "file";
    } else if (proto === "https" || proto === "ssh") {
      scheme = proto;
    } else {
      bad(raw, `scheme ${proto}: is not allowed; use https, ssh, or user@host:path`);
    }
    if (u.password) bad(raw, "credentials in the URL are not allowed");
    if (u.username) {
      if (scheme !== "ssh") bad(raw, "credentials in the URL are not allowed");
      user = u.username;
    }
    if (u.search || u.hash || raw.includes("?") || raw.includes("#")) {
      bad(raw, "query or fragment");
    }
    host = u.hostname.toLowerCase();
    port = u.port || undefined;
    path = u.pathname;
  }

  if (user !== undefined && !USER_RE.test(user)) bad(raw, "bad user name");
  if (scheme !== "file" && !HOST_RE.test(host)) bad(raw, "bad host name");

  const parts = path
    .split("/")
    .filter((s, i, all) => !(s === "" && (i === 0 || i === all.length - 1)));
  let gitSuffix = false;
  if (parts.length > 0 && scheme !== "file") {
    const last = parts[parts.length - 1]!;
    if (last.endsWith(".git") && last.length > 4) {
      parts[parts.length - 1] = last.slice(0, -4);
      gitSuffix = true;
    }
  }
  const segRe = opts.pattern ? PATTERN_SEGMENT_RE : SEGMENT_RE;
  const minSegs = scheme === "file" ? 1 : 2;
  const maxSegs = scheme === "file" ? 32 : 4;
  if (parts.length < minSegs || parts.length > maxSegs) {
    bad(raw, scheme === "file" ? "bad path" : "path must be owner/repo (2 to 4 segments)");
  }
  for (const s of parts) {
    if (!segRe.test(s) || s === "." || s === ".." || s.startsWith("-")) {
      bad(raw, `bad path segment "${s.slice(0, 40)}"`);
    }
  }

  const auth = user ? `${user}@` : "";
  const hostPort = port ? `${host}:${port}` : host;
  const canonical =
    scheme === "file"
      ? `file:///${parts.join("/")}`
      : `${scheme}://${auth}${hostPort}/${parts.join("/")}`;
  return {
    scheme,
    ...(user ? { user } : {}),
    host: scheme === "file" ? "" : host,
    ...(port ? { port } : {}),
    segments: parts,
    canonical,
    cloneUrl: canonical + (gitSuffix ? ".git" : ""),
  };
}

function globSegment(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((p) => p.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"))
        .join("[^/]*") +
      "$",
  );
  return re.test(value);
}

/** True if `url` matches one of the parsed `patterns` (same scheme, user, host, port; `*` within a segment). */
export function urlAllowed(url: RepoUrl, patterns: readonly RepoUrl[]): boolean {
  return patterns.some(
    (p) =>
      p.scheme === url.scheme &&
      p.user === url.user &&
      p.host === url.host &&
      p.port === url.port &&
      p.segments.length === url.segments.length &&
      p.segments.every((s, i) => globSegment(s, url.segments[i]!)),
  );
}

/** Folder names for the managed clone, relative to `workspaces_dir`. */
export function cloneSegments(url: RepoUrl): string[] {
  if (url.scheme === "file") return ["file", ...url.segments];
  return [url.port ? `${url.host}_${url.port}` : url.host, ...url.segments];
}
