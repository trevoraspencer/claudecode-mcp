/**
 * The `claude` argv for a task. Kept in one place so every flag decision is
 * visible together. Prompts never appear here: they go on stdin as
 * stream-json messages.
 *
 * Build step 2 maps the core profile fields. The rest of section 6
 * (settings, tools, plugins, personal hooks and skills, config_dir) arrives
 * in build step 5.
 */

import type { TaskSpec } from "./task-store.js";

/** Linux caps one argv string at 128 KiB (MAX_ARG_STRLEN); stay well below. */
export const MAX_ARG_BYTES = 100 * 1024;

export class ArgTooLargeError extends Error {
  readonly code = "EARGSIZE" as const;
  constructor(what: string) {
    super(`${what} is larger than ${MAX_ARG_BYTES} bytes`);
    this.name = "ArgTooLargeError";
  }
}

function bounded(what: string, value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_ARG_BYTES) throw new ArgTooLargeError(what);
  return value;
}

export function buildClaudeArgs(
  spec: TaskSpec,
  session: { id: string; resume: boolean },
): string[] {
  const p = spec.profile;
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    session.resume ? "--resume" : "--session-id",
    session.id,
    "--permission-mode",
    p.permission_mode,
    // Nobody is there to answer a prompt: anything that would prompt is denied.
    "--permission-prompts",
    "none",
    "--setting-sources",
    p.setting_sources.join(","),
  ];
  const servers = JSON.stringify({ mcpServers: p.mcp_servers });
  if (!p.inherit_user_mcp) {
    args.push("--strict-mcp-config", "--mcp-config", bounded("mcp_servers", servers));
  } else if (Object.keys(p.mcp_servers).length > 0) {
    args.push("--mcp-config", bounded("mcp_servers", servers));
  }
  const model = spec.model ?? p.model;
  if (model) args.push("--model", model);
  const effort = spec.effort ?? p.effort;
  if (effort) args.push("--effort", effort);
  if (spec.system_prompt) {
    args.push("--append-system-prompt", bounded("system_prompt", spec.system_prompt));
  }
  if (spec.output_schema) {
    args.push("--json-schema", bounded("output_schema", JSON.stringify(spec.output_schema)));
  }
  return args;
}
