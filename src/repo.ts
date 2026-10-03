/**
 * Resolving a caller's `repo` path. It must be an existing directory inside
 * one of the config's `allowed_roots`, compared by canonical (realpath)
 * paths so symlinks cannot escape a root.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { expandHome } from "./paths.js";

export class RepoError extends Error {
  readonly code = "EREPO" as const;
  constructor(message: string) {
    super(message);
    this.name = "RepoError";
  }
}

function inside(child: string, root: string): boolean {
  if (child === root) return true;
  const rel = relative(root, child);
  return rel !== "" && !rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel);
}

/** Return the canonical directory for `repo`, or throw RepoError. */
export function resolveRepo(repo: string, allowedRoots: readonly string[]): string {
  const expanded = expandHome(repo);
  if (!isAbsolute(expanded)) throw new RepoError("repo must be an absolute path");
  let real: string;
  try {
    // .native returns the on-disk casing on case-insensitive file systems.
    real = realpathSync.native(expanded);
  } catch {
    throw new RepoError(`repo does not exist: ${repo}`);
  }
  if (!statSync(real).isDirectory()) throw new RepoError(`repo is not a directory: ${repo}`);
  for (const root of allowedRoots) {
    let realRoot: string;
    try {
      realRoot = realpathSync.native(root);
    } catch {
      continue;
    }
    if (inside(real, realRoot)) return real;
  }
  throw new RepoError(
    `repo is outside allowed_roots (${allowedRoots.join(", ") || "none"}): ${repo}`,
  );
}

/** True if `path` is `dir` or inside it (both canonical). */
export function isInside(path: string, dir: string): boolean {
  return inside(path, dir);
}
