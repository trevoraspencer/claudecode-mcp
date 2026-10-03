/**
 * Recursion guard. Every runner sets CLAUDECODE_MCP_DEPTH for its `claude`
 * child. A server that starts inside such a child sees depth >= 1 and its
 * task tools refuse to run, so one task can never fan out into more tasks.
 */

export const DEPTH_ENV = "CLAUDECODE_MCP_DEPTH";

/**
 * Current depth. Unset or empty is 0. Any other value that is not a plain
 * non-negative integer counts as 1: a garbled marker must fail closed.
 */
export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DEPTH_ENV];
  if (raw === undefined || raw === "") return 0;
  if (!/^\d{1,6}$/.test(raw)) return 1;
  return Number(raw);
}

/** The depth value to give a `claude` child started from this process. */
export function childDepth(env: NodeJS.ProcessEnv = process.env): string {
  return String(currentDepth(env) + 1);
}

export class DepthLimitError extends Error {
  readonly code = "EDEPTH" as const;
  constructor(public readonly depth: number) {
    super(
      `claudecode-mcp is running inside a delegated Claude task (${DEPTH_ENV}=${depth}); ` +
        "task tools are disabled to prevent recursive delegation",
    );
    this.name = "DepthLimitError";
  }
}

/** Throw unless this process may start tasks. Call at the top of every task tool. */
export function assertDepthAllowsTasks(env: NodeJS.ProcessEnv = process.env): void {
  const depth = currentDepth(env);
  if (depth >= 1) throw new DepthLimitError(depth);
}
