# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- MCP request cancellation now reaches the active Claude subprocess instead of
  leaving it running until the ten-minute timeout. Timeout, cancellation, and
  output-limit cleanup terminate the complete POSIX process group (including
  descendants), with the existing `SIGTERM`/`SIGKILL` grace sequence.
  Cancellation also reaches the shared `--json-schema` flag probe without
  interrupting other callers that are still waiting on that probe.
- Context-file inclusion is bounded to 32 sequential reads and a 20 MiB
  aggregate context cap, preventing unbounded file-descriptor fan-out and
  memory retention. Opened files are rechecked through their file descriptors
  on Linux to close parent-component symlink-swap races; other platforms
  perform post-open canonical-containment and inode checks.
- `system_prompt`, model identifiers, and serialized JSON schemas now receive
  explicit argv-safe size/shape bounds. Schema preflight also rejects cycles,
  excessive depth/node counts, and lossy non-JSON values before launching the
  CLI; discovery is bounded too, so a very wide object cannot first allocate
  an oversized traversal queue.
- Resource-limit environment variables now accept only bounded positive safe
  integers; oversized Node timer values can no longer be silently clamped to a
  one-millisecond timeout.
- Importing the package from an unrelated script named `server.js` no longer
  starts the MCP transport; entrypoint detection compares canonical paths and
  still supports npm's symlinked executable.
- The filtered child-environment cache now keys on an exact deterministic
  snapshot rather than a collision-prone 32-bit hash.
- Loose JSON recovery now prefers Claude response objects over valid
  JSON-looking diagnostics, selects the longest generic candidate, and bounds
  candidate count/nesting so malformed output cannot amplify memory or CPU.
- The lightweight post-hoc schema check now supports JSON Schema union `type`
  arrays (including nullable objects/arrays) instead of rejecting output the
  Claude CLI had already validated successfully.
- Runtime tool validators now reject unknown arguments as advertised by each
  tool's `additionalProperties: false` schema, preventing misspelled or
  forbidden fields from being silently ignored.
- `skill.sh` now mirrors the server's curated child environment, strips
  dangerous ambient CLI controls, handles option-like directory names safely,
  supports bare mode and large prompts through `./skill.sh -` stdin mode, and
  handles empty arrays safely on Bash 3.2.
- Prompts larger than 100 KiB (including composites built from context files)
  are now delivered to the `claude` CLI via stdin instead of a single argv
  element. Previously any prompt over Linux's 128 KiB per-argument limit
  (`MAX_ARG_STRLEN`) failed at spawn with a raw `E2BIG`, making the documented
  5 MB per-file context capacity unusable. In `--print` mode the CLI reads the
  prompt from stdin when no positional argument is given, so behavior is
  otherwise unchanged; prompts at or under 100 KiB still travel on argv when
  the platform permits. Windows routing now also checks the complete quoted
  command line against the 32,767 UTF-16-unit CreateProcess limit, and
  oversized non-prompt combinations fail cleanly before spawn.
- Prompts that travel on argv are now preceded by a `--` end-of-options
  separator (in the server and in `skill.sh`), so a prompt beginning with `-`
  (e.g. `--continue`, or any composite prompt — composites start with a
  `----- context/file -----` fence) can no longer be parsed by the CLI as a
  flag, which could silently defeat the no-session-persistence guarantee.
- `skill.sh` now passes `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`
  like the MCP server does, closing the recursion footgun the README warns
  about (the wrapper previously loaded the user's own MCP servers).
- The `claude_prompt_structured` "no structured_output" error summary now
  redacts secrets before truncating to 200 chars; previously a secret cut at
  the boundary escaped the env-value redaction and its prefix leaked.
- Fence-like lines inside included file bodies are neutralized for runs of
  5-or-more hyphens (previously exactly 5), matching the path escaping, so a
  `------ end file -----` content line can no longer read as a terminator.
- The in-flight `--json-schema` probe is now keyed by binary path like its
  cache, so changing `CLAUDECODE_MCP_CLAUDE_BIN` mid-probe cannot return the
  old binary's answer.
- CI and release now block on HIGH-severity production dependency advisories.
  The broader all-dependency audit remains non-blocking so an unrelated
  development-tool transitive advisory is still visible without freezing
  every source change.
- `claude_prompt_structured`'s tool description no longer denies the `items`
  validation the sanity check performs (it recurses into array `items`
  schemas; enum/min/max/pattern remain unchecked).

### Security

- Bearer-token redaction now covers case variants and the complete common token
  alphabet. TLS key passphrases, explicitly forwarded environment values, and
  dangerous request/header overrides are also scrubbed, and debug logs no
  longer emit raw subprocess stderr. Client sanitization examines only a
  bounded prefix while still detecting exact secrets that cross its output
  boundary or begin before a whitespace-skipping offset, avoiding both secret
  prefix leaks and large-error memory amplification.
- The curated child environment now retains documented Bedrock, Vertex,
  Foundry, Claude Platform on AWS, standard cloud credentials, and required
  Windows runtime/config-location variables. The explicit dangerous-variable
  override works by itself as documented.
- Updated vulnerable transitive HTTP/parser dependencies and forced
  `@hono/node-server` to the patched 2.x line.
- Checkout steps no longer persist the workflow token in local Git
  configuration during untrusted build/test execution.
- GitHub Actions are pinned to exact commit SHAs (checkout v4.3.1,
  setup-node v4.4.0, upload-artifact v4.6.2) instead of mutable `v4` tags.
- The manual Node 20/22 compatibility matrix now runs on macOS as well as
  Ubuntu, covering the portable path-validation and system Bash 3.2 branches.

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
