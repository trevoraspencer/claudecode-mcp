/**
 * The environment for a `claude` child. It is an explicit allowlist: the full
 * parent environment is never passed through.
 *
 * Order of rules:
 * 1. NEVER_FORWARD vars are always dropped (host session markers that change
 *    child behavior). Nothing can re-enable them.
 * 2. DANGEROUS vars are dropped unless CLAUDECODE_MCP_FORWARD_DANGEROUS=1.
 * 3. Allowlisted names and prefixes, plus names in CLAUDECODE_MCP_EXTRA_ENV,
 *    are copied from the parent.
 * 4. The profile's `env` is applied on top.
 * 5. CLAUDECODE_MCP_DEPTH, NO_COLOR, and TERM are always set by us.
 */

import { childDepth, DEPTH_ENV } from "./depth.js";
import { debugLog } from "./log.js";

/**
 * Markers of a host Claude Code session (or hosted container). Passing them
 * makes the child act as if it were that session: for example `CLAUDECODE`
 * changes nested-session behavior and `CLAUDE_AUTO_BACKGROUND_TASKS` turns
 * on background tasks. Profile `env` may not set these either.
 */
export const NEVER_FORWARD = new Set([
  "CLAUDECODE",
  "CLAUDE_AUTO_BACKGROUND_TASKS",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_WORKER_EPOCH",
  "CLAUDE_CODE_ENVIRONMENT_KIND",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  DEPTH_ENV,
]);
export const NEVER_FORWARD_PREFIXES = ["CLAUDE_CODE_BRIDGE_", "CLAUDE_CODE_REMOTE"];

/**
 * Vars that someone who controls the parent env could use to change API
 * requests or inject shell behavior in the child. Dropped unless
 * CLAUDECODE_MCP_FORWARD_DANGEROUS=1.
 */
export const DANGEROUS_VARS = new Set([
  "CLAUDE_CODE_SHELL_PREFIX",
  "CLAUDE_CODE_EXTRA_BODY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_SCRIPT_CAPS",
]);

export const ALLOWED_EXACT = new Set([
  // Standard shell / locale
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TZ",
  "TMPDIR",
  "LANG",
  // Anthropic auth (https://code.claude.com/docs/en/env-vars)
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  // Cloud-provider selection and auth. Keep this list explicit: do not
  // replace it with broad AWS_/AZURE_/GOOGLE_ prefixes.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "CLOUD_ML_REGION",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_AUTHORITY_HOST",
  // Routing
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  // Model selection
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "ANTHROPIC_BETAS",
  // TLS
  "CLAUDE_CODE_CERT_STORE",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  // Locations
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_DEBUG_LOGS_DIR",
]);

// `CLAUDECODE_MCP_` is our own namespace: forwarded so test stubs and future
// child-readable knobs work. The depth var in it is always overwritten.
export const ALLOWED_PREFIXES = ["LC_", "XDG_", "VERTEX_REGION_CLAUDE_", "CLAUDECODE_MCP_"];

export function isNeverForwarded(key: string): boolean {
  return NEVER_FORWARD.has(key) || NEVER_FORWARD_PREFIXES.some((p) => key.startsWith(p));
}

export interface ChildEnvOptions {
  /** Source environment. Defaults to process.env. */
  parentEnv?: NodeJS.ProcessEnv;
  /** The profile's `env`, applied after filtering. */
  profileEnv?: Readonly<Record<string, string>>;
}

export function buildChildEnv(opts: ChildEnvOptions = {}): Record<string, string> {
  const parent = opts.parentEnv ?? process.env;
  const forwardDangerous = parent.CLAUDECODE_MCP_FORWARD_DANGEROUS === "1";
  const extra = new Set(
    (parent.CLAUDECODE_MCP_EXTRA_ENV ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // A null-prototype map stops specially named keys from touching the
  // object used as spawn's env option.
  const env = Object.create(null) as Record<string, string>;
  let neverDropped = 0;
  let dangerousDropped = 0;
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (isNeverForwarded(key)) {
      neverDropped++;
      continue;
    }
    const dangerous = DANGEROUS_VARS.has(key);
    if (dangerous && !forwardDangerous) {
      dangerousDropped++;
      continue;
    }
    if (
      dangerous ||
      ALLOWED_EXACT.has(key) ||
      ALLOWED_PREFIXES.some((p) => key.startsWith(p)) ||
      extra.has(key)
    ) {
      env[key] = value;
    }
  }
  let profileKeys = 0;
  for (const [key, value] of Object.entries(opts.profileEnv ?? {})) {
    // Config validation rejects these; this is the second line of defense.
    if (isNeverForwarded(key)) continue;
    env[key] = value;
    profileKeys++;
  }
  env[DEPTH_ENV] = childDepth(parent);
  // Pin terminal behavior so the CLI emits no colors or curses.
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  debugLog({
    phase: "env_filter",
    forwarded: Object.keys(env).length,
    never_dropped: neverDropped,
    dangerous_dropped: dangerousDropped,
    profile_keys: profileKeys,
    extra_env_keys: extra.size > 0 ? [...extra] : undefined,
  });
  return env;
}
