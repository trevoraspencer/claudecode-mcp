#!/usr/bin/env bash
# Direct-invocation wrapper for Hermes execute_code or any shell caller.
# Usage: skill.sh "<prompt>" [working_dir]
set -euo pipefail
export NO_COLOR=1
PROMPT="${1:?prompt required}"
DIR="${2:-$(pwd)}"
cd "$DIR"
# Flags mirror baseClaudeArgs() in src/server.ts (non-bare mode), including
# the strict MCP pin so the wrapped CLI can't recursively load the user's own
# MCP servers, and the `--` end-of-options separator so a dash-leading prompt
# can't be parsed as a flag.
exec claude \
  --print \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' \
  --output-format json \
  -- \
  "$PROMPT"
