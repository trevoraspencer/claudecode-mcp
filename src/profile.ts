/**
 * Profiles beyond plain flags (DESIGN-v2 section 6): checking that a
 * profile's files exist, and building the per-task settings file and
 * personal-skills plugin from the user's own Claude setup.
 *
 * "Personal" means the user's Claude home: `$CLAUDE_CONFIG_DIR` or
 * `~/.claude`. A profile's `config_dir` is a different thing: the child's
 * whole Claude home.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isNeverForwarded } from "./child-env.js";
import type { Config, Profile } from "./config.js";

/**
 * Reserved variables (depth marker, host-session markers) set through a
 * settings file's `env`. Claude Code applies that `env` to itself and every
 * child (hooks, Bash, MCP servers), so it could reset the depth guard.
 */
export function reservedSettingsEnv(settings: Record<string, unknown>): string[] {
  const env = settings.env;
  if (!env || typeof env !== "object") return [];
  return Object.keys(env).filter((k) => isNeverForwarded(k));
}

export const PERSONAL_PLUGIN_NAME = "claudecode-personal";

export class ProfileError extends Error {
  readonly code = "EPROFILEREF" as const;
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export function personalHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

type HookEntry = Record<string, unknown>;

function readJson(path: string, what: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ProfileError(`${what} not found: ${path}`);
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (err) {
    throw new ProfileError(`${what} is not a JSON object (${(err as Error).message}): ${path}`);
  }
}

/** The user's hook entries by event, from their personal settings.json. */
export function personalHooks(env: NodeJS.ProcessEnv = process.env): Record<string, HookEntry[]> {
  const path = join(personalHome(env), "settings.json");
  if (!existsSync(path)) return {};
  const hooks = readJson(path, "personal settings").hooks;
  if (!hooks || typeof hooks !== "object") return {};
  const out: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (Array.isArray(entries)) out[event] = entries as HookEntry[];
  }
  return out;
}

/** Skill folder names under the personal skills dir (each with a SKILL.md). */
export function personalSkills(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = join(personalHome(env), "skills");
  try {
    return readdirSync(dir)
      .filter((name) => existsSync(join(dir, name, "SKILL.md")))
      .sort();
  } catch {
    return [];
  }
}

/** Parse "<Event>:<index>" into its parts. */
function parseHookRef(ref: string): { event: string; index: number } {
  const i = ref.indexOf(":");
  const event = ref.slice(0, i);
  const index = ref.slice(i + 1);
  if (i <= 0 || !/^\d{1,4}$/.test(index)) {
    throw new ProfileError(
      `personal hook "${ref}" must look like <Event>:<index>, e.g. PostToolUse:0`,
    );
  }
  return { event, index: Number(index) };
}

function pickHooks(refs: readonly string[], env: NodeJS.ProcessEnv): Record<string, HookEntry[]> {
  if (refs.length === 0) return {};
  const all = personalHooks(env);
  const picked: Record<string, HookEntry[]> = {};
  for (const ref of refs) {
    const { event, index } = parseHookRef(ref);
    const entry = all[event]?.[index];
    if (!entry) {
      throw new ProfileError(
        `personal hook "${ref}" not found in ${join(personalHome(env), "settings.json")}; ` +
          "run `claudecode-mcp list-personal-config` to see the available hooks",
      );
    }
    (picked[event] ??= []).push(entry);
  }
  return picked;
}

/** Check one profile's references against the file system. Returns problems. */
export function profileProblems(
  name: string,
  p: Profile,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const problems: string[] = [];
  const at = `profile "${name}"`;
  try {
    pickHooks(p.personal_hooks, env);
  } catch (err) {
    problems.push(`${at}: ${(err as Error).message}`);
  }
  const skills = new Set(personalSkills(env));
  for (const skill of p.personal_skills) {
    if (!skills.has(skill)) {
      problems.push(
        `${at}: personal skill "${skill}" not found in ${join(personalHome(env), "skills")} (needs ${skill}/SKILL.md)`,
      );
    }
  }
  for (const dir of p.plugin_dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      problems.push(`${at}: plugin dir not found: ${dir}`);
  }
  const settingsToCheck: Array<{ what: string; read: () => Record<string, unknown> }> = [];
  if (typeof p.settings === "string") {
    const path = p.settings;
    settingsToCheck.push({ what: path, read: () => readJson(path, "settings file") });
  } else if (p.settings) {
    const inline = p.settings as Record<string, unknown>;
    settingsToCheck.push({ what: "inline settings", read: () => inline });
  }
  if (p.setting_sources.includes("user")) {
    // User-level settings load too; their env reaches the child the same way.
    const path = join(p.config_dir ?? personalHome(env), "settings.json");
    if (existsSync(path))
      settingsToCheck.push({ what: path, read: () => readJson(path, "user settings") });
  }
  for (const { what, read } of settingsToCheck) {
    try {
      const reserved = reservedSettingsEnv(read());
      if (reserved.length > 0) {
        problems.push(
          `${at}: ${what} sets reserved environment variables in "env": ${reserved.join(", ")}`,
        );
      }
    } catch (err) {
      problems.push(`${at}: ${(err as Error).message}`);
    }
  }
  if (p.config_dir && (!existsSync(p.config_dir) || !statSync(p.config_dir).isDirectory())) {
    problems.push(`${at}: config_dir not found: ${p.config_dir}`);
  }
  return problems;
}

/** Throw a ProfileError listing every broken reference in the config. */
export function assertProfilesValid(config: Config, env: NodeJS.ProcessEnv = process.env): void {
  const problems = Object.entries(config.profiles).flatMap(([name, p]) =>
    profileProblems(name, p, env),
  );
  if (problems.length > 0) throw new ProfileError(problems.join("\n"));
}

export interface Materialized {
  /** Settings file to pass with --settings (generated or the profile's own). */
  settings_file?: string;
  /** Generated plugin folder holding links to the chosen personal skills. */
  personal_plugin_dir?: string;
}

/**
 * Build the task's generated files in `taskDir`: one settings file (the
 * profile's settings plus chosen personal hooks) and a plugin folder linking
 * the chosen personal skills. Throws ProfileError if a reference is broken.
 */
export function materializeProfile(
  name: string,
  p: Profile,
  taskDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Materialized {
  const problems = profileProblems(name, p, env);
  if (problems.length > 0) throw new ProfileError(problems.join("\n"));
  const out: Materialized = {};

  const hooks = pickHooks(p.personal_hooks, env);
  const needGenerated = typeof p.settings === "object" || Object.keys(hooks).length > 0;
  if (needGenerated) {
    const base: Record<string, unknown> =
      typeof p.settings === "string"
        ? readJson(p.settings, "settings file")
        : { ...((p.settings as Record<string, unknown> | undefined) ?? {}) };
    if (Object.keys(hooks).length > 0) {
      const merged: Record<string, unknown[]> = {
        ...((base.hooks as Record<string, unknown[]> | undefined) ?? {}),
      };
      for (const [event, entries] of Object.entries(hooks)) {
        merged[event] = [...(Array.isArray(merged[event]) ? merged[event] : []), ...entries];
      }
      base.hooks = merged;
    }
    const file = join(taskDir, "settings.json");
    writeFileSync(file, JSON.stringify(base, null, 2) + "\n", { mode: 0o600 });
    out.settings_file = file;
  } else if (typeof p.settings === "string") {
    out.settings_file = p.settings;
  }

  if (p.personal_skills.length > 0) {
    // --plugin-dir needs an absolute path; skills are symlinks, not copies,
    // so edits to the user's skills apply to later turns too.
    const dir = join(taskDir, "personal-plugin");
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "skills"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: PERSONAL_PLUGIN_NAME,
        version: "1.0.0",
        description: "Personal skills chosen for this claudecode-mcp task",
      }) + "\n",
    );
    const source = join(personalHome(env), "skills");
    for (const skill of p.personal_skills) {
      const link = join(dir, "skills", skill);
      if (!existsSync(link)) symlinkSync(join(source, skill), link);
    }
    out.personal_plugin_dir = dir;
  }
  return out;
}

/** Text for `claudecode-mcp list-personal-config`. */
export function describePersonalConfig(env: NodeJS.ProcessEnv = process.env): string {
  const home = personalHome(env);
  const lines = [`Personal Claude home: ${home}`, "", "Hooks (use as personal_hooks entries):"];
  let hooks: Record<string, HookEntry[]> = {};
  try {
    hooks = personalHooks(env);
  } catch (err) {
    lines.push(`  (cannot read settings.json: ${(err as Error).message})`);
  }
  let count = 0;
  for (const [event, entries] of Object.entries(hooks)) {
    entries.forEach((entry, i) => {
      count++;
      const matcher =
        typeof entry.matcher === "string" && entry.matcher ? ` matcher=${entry.matcher}` : "";
      const cmds = Array.isArray(entry.hooks)
        ? (entry.hooks as Array<Record<string, unknown>>)
            .map((h) => String(h.command ?? h.type ?? "?").slice(0, 80))
            .join(" ; ")
        : "";
      lines.push(`  ${event}:${i}${matcher}  ${cmds}`);
    });
  }
  if (count === 0) lines.push("  (none)");
  lines.push("", "Skills (use as personal_skills entries):");
  const skills = personalSkills(env);
  lines.push(...(skills.length ? skills.map((s) => `  ${s}`) : ["  (none)"]));
  return lines.join("\n") + "\n";
}
