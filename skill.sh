#!/usr/bin/env bash
# Direct-invocation wrapper for Hermes execute_code or any shell caller.
# Usage: skill.sh "<prompt>" [working_dir]
set -euo pipefail
export NO_COLOR=1
PROMPT="${1:?prompt required}"
DIR="${2:-$(pwd)}"
cd "$DIR"
exec claude \
  --print \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --output-format json \
  "$PROMPT"
