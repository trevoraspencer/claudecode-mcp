#!/usr/bin/env bash
# Direct-invocation wrapper for Hermes execute_code or any shell caller.
# Usage: skill.sh "<prompt>|-" [working_dir]
# Use "-" (or omit the prompt) to read it from stdin, which also supports
# payloads too large to fit in a single operating-system argv element.
set -euo pipefail
PROMPT_MODE="stdin"
PROMPT=""
if (( $# > 0 )) && [[ "$1" != "-" ]]; then
  PROMPT_MODE="argv"
  PROMPT="$1"
fi
DIR="${2:-$(pwd)}"
cd -- "$DIR"

# Mirror the MCP server's explicit child-environment allowlist. This prevents
# shell-prefix/API-header injection through ambient variables while retaining
# OAuth/keychain locations, provider credentials, locale, and opt-in extras.
CHILD_ENV=()
EXTRA_NAMES=()
IFS=',' read -r -a RAW_EXTRA_NAMES <<< "${CLAUDECODE_MCP_EXTRA_ENV:-}"
# `${array[@]-}` remains safe under `set -u` on the Bash 3.2 shipped by
# macOS, where expanding a declared-but-empty array can otherwise fail.
for extra_name in "${RAW_EXTRA_NAMES[@]-}"; do
  extra_name="${extra_name#"${extra_name%%[![:space:]]*}"}"
  extra_name="${extra_name%"${extra_name##*[![:space:]]}"}"
  if [[ "$extra_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    EXTRA_NAMES+=("$extra_name")
  fi
done
while IFS= read -r name; do
  [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
  allowed=0
  case "$name" in
    CLAUDE_CODE_SHELL_PREFIX|CLAUDE_CODE_EXTRA_BODY|ANTHROPIC_CUSTOM_HEADERS|CLAUDE_CODE_SCRIPT_CAPS|CLAUDECODE)
      if [[ "${CLAUDECODE_MCP_FORWARD_DANGEROUS:-}" != "1" ]]; then
        continue
      fi
      allowed=1
      ;;
  esac

  case "$name" in
    PATH|HOME|USER|LOGNAME|SHELL|TERM|TZ|TMPDIR|LANG|APPDATA|LOCALAPPDATA|\
    PROGRAMDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|SYSTEMROOT|WINDIR|COMSPEC|\
    PATHEXT|TEMP|TMP|\
    ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|\
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN|CLAUDE_CODE_OAUTH_SCOPES|\
    CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_MANTLE|CLAUDE_CODE_USE_VERTEX|\
    CLAUDE_CODE_USE_FOUNDRY|CLAUDE_CODE_USE_ANTHROPIC_AWS|\
    CLAUDE_CODE_SKIP_BEDROCK_AUTH|CLAUDE_CODE_SKIP_MANTLE_AUTH|\
    CLAUDE_CODE_SKIP_VERTEX_AUTH|CLAUDE_CODE_SKIP_FOUNDRY_AUTH|\
    CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH|AWS_BEARER_TOKEN_BEDROCK|\
    AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_PROFILE|\
    AWS_REGION|AWS_DEFAULT_REGION|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|\
    AWS_ROLE_ARN|AWS_ROLE_SESSION_NAME|AWS_WEB_IDENTITY_TOKEN_FILE|\
    ANTHROPIC_AWS_API_KEY|ANTHROPIC_AWS_WORKSPACE_ID|\
    ANTHROPIC_FOUNDRY_API_KEY|ANTHROPIC_FOUNDRY_AUTH_TOKEN|\
    ANTHROPIC_FOUNDRY_RESOURCE|ANTHROPIC_VERTEX_PROJECT_ID|\
    GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT|\
    CLOUD_ML_REGION|AZURE_CLIENT_ID|AZURE_TENANT_ID|AZURE_CLIENT_SECRET|\
    AZURE_CLIENT_CERTIFICATE_PATH|AZURE_CLIENT_CERTIFICATE_PASSWORD|\
    AZURE_FEDERATED_TOKEN_FILE|AZURE_AUTHORITY_HOST|\
    ANTHROPIC_BASE_URL|ANTHROPIC_AWS_BASE_URL|ANTHROPIC_BEDROCK_BASE_URL|\
    ANTHROPIC_BEDROCK_MANTLE_BASE_URL|ANTHROPIC_FOUNDRY_BASE_URL|\
    ANTHROPIC_VERTEX_BASE_URL|ANTHROPIC_MODEL|ANTHROPIC_DEFAULT_FABLE_MODEL|\
    ANTHROPIC_DEFAULT_SONNET_MODEL|\
    ANTHROPIC_DEFAULT_OPUS_MODEL|ANTHROPIC_DEFAULT_HAIKU_MODEL|ANTHROPIC_BETAS|\
    ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION|\
    CLAUDE_CODE_CERT_STORE|CLAUDE_CODE_CLIENT_CERT|CLAUDE_CODE_CLIENT_KEY|\
    CLAUDE_CODE_CLIENT_KEY_PASSPHRASE|CLAUDE_CONFIG_DIR|\
    CLAUDE_CODE_DEBUG_LOGS_DIR|LC_*|XDG_*|VERTEX_REGION_CLAUDE_*|CLAUDECODE_MCP_*)
      allowed=1
      ;;
  esac
  for extra_name in "${EXTRA_NAMES[@]-}"; do
    if [[ "$name" == "$extra_name" ]]; then
      allowed=1
      break
    fi
  done
  if (( allowed == 1 )); then
    CHILD_ENV+=("$name=${!name}")
  fi
done < <(compgen -e)
CHILD_ENV+=("NO_COLOR=1" "TERM=dumb")

# Flags mirror baseClaudeArgs() in src/server.ts, including bare-mode opt-in
# and the strict MCP pin in default mode.
CLAUDE_ARGS=()
if [[ "${CLAUDECODE_MCP_BARE:-}" == "1" ]]; then
  CLAUDE_ARGS+=(--bare)
fi
CLAUDE_ARGS+=(--print --permission-mode bypassPermissions --no-session-persistence)
if [[ "${CLAUDECODE_MCP_BARE:-}" != "1" ]]; then
  CLAUDE_ARGS+=(--strict-mcp-config --mcp-config '{"mcpServers":{}}')
fi
CLAUDE_ARGS+=(--output-format json)

if [[ "$PROMPT_MODE" == "argv" ]]; then
  exec env -i "${CHILD_ENV[@]}" claude "${CLAUDE_ARGS[@]}" -- "$PROMPT"
else
  exec env -i "${CHILD_ENV[@]}" claude "${CLAUDE_ARGS[@]}"
fi
