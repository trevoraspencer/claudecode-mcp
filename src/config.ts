/**
 * Server config: limits, allowed repo roots, and profiles. Loaded once at
 * startup from `~/.config/claudecode-mcp/config.json` (see paths.ts). A
 * missing file means built-in defaults; an invalid file is a startup error.
 * Unknown keys are errors too, so a typo in a safety setting never passes
 * silently.
 *
 * Profiles are validated here. They are turned into `claude` flags by the
 * runner (DESIGN-v2 section 6).
 */

import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { isNeverForwarded } from "./child-env.js";
import { configPath, expandHome } from "./paths.js";

export const MAX_CONFIG_BYTES = 1024 * 1024;
export const SELF_NAME = "claudecode-mcp";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const noControlChars = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

/** An absolute path or one starting with `~/`; expanded and normalized. */
const pathString = z
  .string()
  .min(1)
  .max(4096)
  .refine(noControlChars, "must not contain control characters")
  .transform((p) => expandHome(p))
  .refine((p) => isAbsolute(p), "must be an absolute path or start with ~/")
  .transform((p) => resolve(p));

const profileName = z.string().regex(NAME_RE, "must match " + NAME_RE.source);

/** Tool names and permission rules, e.g. `Bash(git push:*)`. */
const toolRule = z.string().min(1).max(256).refine(noControlChars, "invalid tool rule");

function mentionsSelf(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.toLowerCase() === SELF_NAME || basename(value).toLowerCase() === SELF_NAME)
  );
}

/**
 * One entry in Claude Code's MCP server format. Kept loose (beyond the
 * fields we check) because that format belongs to Claude Code and grows.
 */
const mcpServer = z
  .looseObject({
    type: z.string().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    url: z.string().min(1).optional(),
  })
  .refine((s) => s.command !== undefined || s.url !== undefined, "needs `command` or `url`")
  .refine(
    (s) => !mentionsSelf(s.command) && !(s.args ?? []).some(mentionsSelf),
    "this server may not be given to its own tasks",
  );

const envKey = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "invalid environment variable name")
  .refine((k) => !isNeverForwarded(k), "this variable is reserved and cannot be set");

export const profileSchema = z.strictObject({
  permission_mode: z.enum(["auto", "bypassPermissions"]).default("auto"),
  setting_sources: z
    .array(z.enum(["user", "project", "local"]))
    .max(3)
    .refine((a) => new Set(a).size === a.length, "must not repeat a source")
    .default(["project", "local"]),
  settings: z.union([pathString, z.record(z.string(), z.unknown())]).optional(),
  mcp_servers: z
    .record(
      z
        .string()
        .regex(NAME_RE, "must match " + NAME_RE.source)
        .refine(
          (n) => n.toLowerCase() !== SELF_NAME,
          "this server may not be given to its own tasks",
        ),
      mcpServer,
    )
    .default({}),
  inherit_user_mcp: z.boolean().default(false),
  disallowed_tools: z.array(toolRule).max(256).default([]),
  tools: z.array(toolRule).max(256).optional(),
  plugin_dirs: z.array(pathString).max(64).default([]),
  skills: z.boolean().default(true),
  personal_hooks: z
    .array(z.string().regex(/^[A-Za-z]+:\S{1,128}$/, "must look like <Event>:<id>"))
    .max(128)
    .default([]),
  personal_skills: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "must be a skill folder name"))
    .max(128)
    .default([]),
  config_dir: pathString.optional(),
  model: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/, "invalid model name")
    .optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  env: z.record(envKey, z.string().max(32 * 1024)).default({}),
});

export type Profile = z.output<typeof profileSchema>;

export const DEFAULT_PROFILE_NAME = "worker";

/** The profile used when the config defines none (DESIGN-v2 section 6). */
export function builtinWorkerProfile(): Profile {
  return profileSchema.parse({});
}

export const configSchema = z
  .strictObject({
    $schema: z.string().optional(),
    allowed_roots: z
      .array(pathString)
      .max(64)
      .default([expandHome("~")]),
    max_concurrent: z.int().min(1).max(16).default(3),
    max_minutes: z
      .int()
      .min(1)
      .max(24 * 60)
      .default(120),
    stall_minutes: z
      .int()
      .min(1)
      .max(24 * 60)
      .default(10),
    stale_days: z.int().min(1).max(365).default(7),
    default_profile: profileName.default(DEFAULT_PROFILE_NAME),
    profiles: z.record(profileName, profileSchema).default({}),
  })
  .transform((c) => {
    const { $schema: _schema, ...rest } = c;
    const profiles =
      Object.keys(rest.profiles).length > 0
        ? rest.profiles
        : { [DEFAULT_PROFILE_NAME]: builtinWorkerProfile() };
    return { ...rest, profiles };
  })
  .superRefine((c, ctx) => {
    if (!Object.hasOwn(c.profiles, c.default_profile)) {
      ctx.addIssue({
        code: "custom",
        path: ["default_profile"],
        message: `profile "${c.default_profile}" is not defined in "profiles"`,
      });
    }
    if (c.stall_minutes >= c.max_minutes) {
      ctx.addIssue({
        code: "custom",
        path: ["stall_minutes"],
        message: "must be less than max_minutes",
      });
    }
  });

export type Config = z.output<typeof configSchema>;

export interface LoadedConfig {
  config: Config;
  /** Path that was read, or would have been read when `source` is "defaults". */
  path: string;
  source: "file" | "defaults";
}

export class ConfigError extends Error {
  readonly code = "ECONFIG" as const;
  constructor(
    public readonly path: string,
    detail: string,
  ) {
    super(`invalid claudecode-mcp config (${path}): ${detail}`);
    this.name = "ConfigError";
  }
}

/** Validate an already-parsed config value. */
export function parseConfig(value: unknown, path = "<inline>"): Config {
  const result = configSchema.safeParse(value);
  if (!result.success) throw new ConfigError(path, "\n" + z.prettifyError(result.error));
  return result.data;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const path = configPath(env);
  let raw: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new ConfigError(path, "not a regular file");
    if (st.size > MAX_CONFIG_BYTES) {
      throw new ConfigError(path, `larger than ${MAX_CONFIG_BYTES} bytes`);
    }
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: parseConfig({}, path), path, source: "defaults" };
    }
    throw new ConfigError(path, `cannot read: ${(err as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(path, `not valid JSON: ${(err as Error).message}`);
  }
  return { config: parseConfig(value, path), path, source: "file" };
}

export class UnknownProfileError extends Error {
  readonly code = "EPROFILE" as const;
  constructor(name: string, known: readonly string[]) {
    super(`unknown profile "${name}"; defined profiles: ${known.join(", ")}`);
    this.name = "UnknownProfileError";
  }
}

/** Pick a profile by name, or the config's default profile. */
export function resolveProfile(config: Config, name?: string): { name: string; profile: Profile } {
  const chosen = name ?? config.default_profile;
  if (!Object.hasOwn(config.profiles, chosen)) {
    throw new UnknownProfileError(chosen, Object.keys(config.profiles));
  }
  return { name: chosen, profile: config.profiles[chosen]! };
}
