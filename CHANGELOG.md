# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Prompts larger than 100 KiB (including composites built from context files)
  are now delivered to the `claude` CLI via stdin instead of a single argv
  element. Previously any prompt over Linux's 128 KiB per-argument limit
  (`MAX_ARG_STRLEN`) failed at spawn with a raw `E2BIG`, making the documented
  5 MB per-file context capacity unusable. In `--print` mode the CLI reads the
  prompt from stdin when no positional argument is given, so behavior is
  otherwise unchanged; prompts at or under 100 KiB still travel on argv.

### Documentation
- Added `AGENTS.md` as the canonical public guide for AI agents, and reduced
  `CLAUDE.md` and `GEMINI.md` to compatibility pointers.

## [1.0.1] - 2026-05-12

### Security
- Strip dangerous parent-env vars from the child subprocess by default
  (`CLAUDE_CODE_SHELL_PREFIX`, `CLAUDE_CODE_EXTRA_BODY`,
  `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_SCRIPT_CAPS`, `CLAUDECODE`).
  An attacker who controls the parent env can no longer inject command
  prefixes or alter API requests.
- Replace `process.env` pass-through with an explicit allowlist for
  shell/locale, Anthropic auth, provider auth, routing, model selection,
  TLS, and `CLAUDE_CODE_*` location overrides. Escape hatch:
  `CLAUDECODE_MCP_EXTRA_ENV` (comma-separated keys).
- `claude_prompt_with_context`: file paths are now resolved strictly under
  the server's cwd. Absolute paths, `..` escapes, and symlinks pointing
  outside cwd are rejected. Per-file size cap defaults to 5 MB
  (`CLAUDECODE_MCP_MAX_FILE_BYTES`).
- Wrapped subprocess no longer loads the user's MCP servers: every call now
  passes `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` so the child
  cannot recursively load `claudecode-mcp` from `~/.claude/mcp.json`. Opt
  into the official `--bare` mode (skips hooks, plugins, skills, CLAUDE.md,
  etc.) with `CLAUDECODE_MCP_BARE=1`.
- Error messages returned to MCP clients are truncated (1 KB) and redact
  `sk-ant-*` tokens, `Bearer` headers, and any verbatim values from known
  auth env vars. Full text is logged to local stderr for server-side debug.

### Added
- Per-call subprocess timeout, default 10 min, override with
  `CLAUDECODE_MCP_TIMEOUT_MS`. Stuck processes are killed with `SIGTERM` then
  `SIGKILL` after a 2s grace.
- Output cap on combined stdout/stderr, default 50 MB, override with
  `CLAUDECODE_MCP_MAX_OUTPUT_BYTES`. Overflow kills the child and rejects
  with `OutputTooLargeError`.
- File-context blocks now use sentinel-fenced `----- file: NAME -----`
  markers instead of pseudo-XML, so quotes / angle brackets in paths cannot
  break block boundaries.
- New tests: `composite.test.mjs`, `dispatch.test.mjs`, `path_guard.test.mjs`,
  `invoke_timeout.test.mjs`, `parse_json_loose.test.mjs`,
  `redaction.test.mjs`, `debug_logging.test.mjs`.
- `--json-schema` probe cache now keyed by binary path and has a 5-minute
  TTL, so CLI upgrades take effect without restart. Concurrent first-callers
  share a single in-flight probe.
- `DEBUG=claudecode-mcp` enables structured one-line-per-event stderr logs
  for spawn / call / exit. No prompt bodies are ever logged.
- npm package now ships `examples/` (three JSON-RPC sample requests plus a
  README) so users installing globally can drive the server by hand.
- `prepack` and `prepublishOnly` scripts guarantee `dist/` is rebuilt and
  tests pass before any tarball or publish.
- Build script now `chmod 755`s `dist/server.js` so running it directly as
  `./dist/server.js` works on Unix.
- CI runs `npm audit --omit=dev --audit-level=high` after tests (non-blocking)
  to surface new HIGH-severity advisories in production deps.

### Documentation
- Documented recommended minimum `claude` CLI version (2.1.0+) given the
  brief `--no-session-persistence` regression in 2.0.57.
- README "Design notes" rewritten with timeout, output cap, env allowlist,
  file-context safety, error redaction, and bare-mode opt-in details.
- CLAUDE.md (project instructions) updated with the new invariants.

### Changed
- `runClaudePrompt` no longer silently returns raw stdout when JSON parsing
  fails. It now throws a clear "output was not parseable JSON" error.
- `parseJsonLoose`'s last-resort fallback is now a balanced-bracket scan
  instead of `firstBrace…lastBrace`, so asymmetric `{ … ]` runs don't yield
  bogus parses.
- `claude_prompt_structured`'s tool input schema now requires `schema` (was
  optional at the MCP layer; the runtime check already enforced it).
- MCP dispatch handlers (`handleCallTool`, `listTools`) are now exported for
  test coverage.

## [1.0.0] - 2026-05-12

### Added
- Initial public release of `claudecode-mcp`, a stateless stdio MCP server
  wrapping the headless `claude` CLI as three MCP tools:
  - `claude_prompt` — one-shot text prompt; returns the model's text response.
  - `claude_prompt_with_context` — same, with optional free-form context and
    file contents prepended as labeled blocks.
  - `claude_prompt_structured` — schema-constrained JSON output via the CLI's
    `--json-schema` flag, with lightweight post-hoc validation. Fails loudly
    if the installed CLI lacks `--json-schema` (no prompt-coercion fallback).
- Stateless design: no session tracking, no `session_id`, no `--resume`;
  every call is a fresh `claude` subprocess with `--no-session-persistence`.
- Argv-array spawning only — prompts are never shell-interpolated.
- Sanitized child env (`NO_COLOR=1`, `TERM=dumb`); inherits PATH/HOME and
  whatever auth (OAuth/keychain/`ANTHROPIC_API_KEY`) the user's `claude` CLI
  is already configured with. `--bare` is intentionally not used.
- No `working_dir` parameter; uses the server process's `process.cwd()`.
- No timeout enforcement; trusts the CLI's own turn limits.
- GitHub Actions CI: typecheck + build + offline tests on Node 20 and 22.

[1.0.1]: https://github.com/trevoraspencer/claudecode-mcp/releases/tag/v1.0.1
[1.0.0]: https://github.com/trevoraspencer/claudecode-mcp/releases/tag/v1.0.0
