/**
 * `get_diff`: what a task changed since its base commit. Covers commits,
 * uncommitted tracked changes, and untracked files (shown as new files).
 */

import { git, run } from "./git.js";

export const DIFF_MAX_BYTES = 200 * 1024;
const MAX_COMMITS = 50;
const MAX_UNTRACKED = 500;

export interface DiffResult {
  base_commit: string;
  head: string;
  branch?: string;
  commits: string[];
  commits_truncated?: boolean;
  stat: string;
  untracked: string[];
  untracked_truncated?: boolean;
  diff?: string;
  diff_truncated?: boolean;
  diff_full_bytes?: number;
}

export async function taskDiff(
  dir: string,
  base: string,
  statOnly: boolean,
  branch?: string,
): Promise<DiffResult> {
  const head = (await git(["rev-parse", "HEAD"], dir)).trim();
  const log = await git(
    ["log", "--oneline", "--no-color", `--max-count=${MAX_COMMITS + 1}`, `${base}..HEAD`],
    dir,
  );
  const commits = log.split("\n").filter(Boolean);
  const stat = await git(["diff", "--stat", "--no-color", "--no-ext-diff", base, "--"], dir);
  const others = (await git(["ls-files", "--others", "--exclude-standard", "-z"], dir))
    .split("\0")
    .filter(Boolean);
  const result: DiffResult = {
    base_commit: base,
    head,
    ...(branch ? { branch } : {}),
    commits: commits.slice(0, MAX_COMMITS),
    ...(commits.length > MAX_COMMITS ? { commits_truncated: true } : {}),
    stat: stat.trimEnd(),
    untracked: others.slice(0, MAX_UNTRACKED),
    ...(others.length > MAX_UNTRACKED ? { untracked_truncated: true } : {}),
  };
  if (statOnly) return result;

  const tracked = await run(
    "git",
    ["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, "--"],
    dir,
  );
  if (tracked.code !== 0 && !tracked.truncated) {
    throw new Error(`git diff failed: ${tracked.stderr.trim().slice(0, 500)}`);
  }
  let cut = tracked.truncated === true;
  const parts = [tracked.stdout];
  let bytes = Buffer.byteLength(tracked.stdout, "utf8");
  for (const file of others.slice(0, MAX_UNTRACKED)) {
    if (bytes > DIFF_MAX_BYTES) {
      cut = true;
      break;
    }
    // Exit code 1 means "files differ", which is the expected case here.
    const r = await run(
      "git",
      [
        "diff",
        "--no-index",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        "/dev/null",
        file,
      ],
      dir,
    );
    parts.push(r.stdout);
    bytes += Buffer.byteLength(r.stdout, "utf8");
    if (r.truncated) cut = true;
  }
  const full = parts.join("");
  const fullBytes = Buffer.byteLength(full, "utf8");
  if (cut || fullBytes > DIFF_MAX_BYTES || others.length > MAX_UNTRACKED) {
    result.diff = Buffer.from(full, "utf8").subarray(0, DIFF_MAX_BYTES).toString("utf8");
    result.diff_truncated = true;
    // At least this many bytes; more if a part hit the read cap.
    result.diff_full_bytes = fullBytes;
  } else {
    result.diff = full;
  }
  return result;
}
