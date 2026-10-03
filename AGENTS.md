# AGENTS.md

Canonical public guide for AI agents and contributors working in this repository.

## Project purpose

`claudecode-mcp` v2 is a stdio MCP server that runs Claude Code as an **async
task runner**. Any MCP client can hand coding work or a review to Claude Code,
track progress, steer it, and collect the result.

`docs/DESIGN-v2.md` is the source of truth for the v2 design. Read it before
changing behavior. v2 is built in steps (design section 10), one PR per step.
v1 (one-shot `claude_prompt*` tools) was removed in step 1 and lives on in the
1.x releases on npm.

Build status: step 1 (skeleton) is done. The server starts, loads config,
and prepares the state dir. It exposes no tools until step 3.

## Core commands

- `npm install` - install dependencies.
- `npm run build` - compile TypeScript into `dist/` and make `dist/cli.js`
  executable.
- `npm test` - run the offline test suite. The `pretest` hook builds first.
- `npm run test:live` - run tests with `CLAUDECODE_MCP_LIVE=1`; requires a
  real authenticated `claude` CLI on `PATH`.
- `npm run format:check` / `npm run format` - Prettier for `src/**/*.ts` and
  `test/**/*.mjs`.

Before pushing, run:

```sh
npm run format:check
npx tsc --noEmit -p tsconfig.json
npm test
npm audit --omit=dev --audit-level=high
```

Single tests can be run after building:

```sh
npm run build
node --test --test-name-pattern='<regex>' test/<file>.test.mjs
```

## CI expectations

GitHub Actions runs the required workflow on Node 22 and 24 (ubuntu):
`npm ci`, format check, typecheck, build, offline tests, a blocking
production `npm audit --omit=dev --audit-level=high`, and an advisory full
audit. The manual compatibility workflow adds macOS. Release validation also
runs `npm pack --dry-run`.

## Architecture map

- `src/cli.ts` - package entry (`bin`). No args starts the MCP server;
  `runner <task-id>` is reserved for the runner (step 2). Refuses Node < 22
  and Windows.
- `src/server.ts` - stdio MCP server: startup (`prepare`), server factory.
- `src/config.ts` - config and profile schema (zod), `loadConfig`,
  `resolveProfile`.
- `src/paths.ts` - config path, state dir, `ensureStateDir`.
- `src/child-env.ts` - the `claude` child's environment allowlist.
- `src/depth.ts` - recursion guard (`CLAUDECODE_MCP_DEPTH`).
- `src/claude-cli.ts` - `claude` binary lookup and minimum version check.
- `src/redaction.ts` - secret redaction and client-safe error text.
- `src/log.ts` - structured stderr logging.
- `src/env.ts` - bounded integer env parsing.

Tests live in `test/` and import compiled modules from `dist/`.
`test/_fake_claude.mjs` is the fake CLI for offline tests.

## Files and locations

- Config: `$XDG_CONFIG_HOME/claudecode-mcp/config.json` (default
  `~/.config/...`). Override: `CLAUDECODE_MCP_CONFIG`.
- State: `$XDG_STATE_HOME/claudecode-mcp/` (default `~/.local/state/...`),
  with `tasks/<task-id>/` per task. Override: `CLAUDECODE_MCP_STATE_DIR`.
- `claude` binary: `claude` on `PATH`. Override: `CLAUDECODE_MCP_CLAUDE_BIN`.

## Non-negotiable invariants

- Platforms: macOS and Linux only. Node 22 or newer. No Windows code paths.
- Minimum `claude` CLI version is `MIN_CLAUDE_VERSION` (2.1.287). Check the
  version; do not probe `--help` for individual flags.
- Spawn `claude` with argv arrays only. Never build shell command strings
  from prompts or user input. Send prompts on stdin (stream-json), never as
  argv.
- The child environment is an explicit allowlist (`buildChildEnv`). Never
  pass the full parent environment.
  - `NEVER_FORWARD` host-session markers (`CLAUDECODE`,
    `CLAUDE_AUTO_BACKGROUND_TASKS`, `CLAUDE_CODE_SESSION_ID`, and the
    others in `child-env.ts`) are always dropped. No flag, extra-env list, or
    profile `env` can re-enable them.
  - `DANGEROUS_VARS` are dropped unless `CLAUDECODE_MCP_FORWARD_DANGEROUS=1`.
  - `CLAUDECODE_MCP_DEPTH`, `NO_COLOR`, and `TERM` are always set by us.
- Depth guard: every task tool calls `assertDepthAllowsTasks()` first. A
  server at depth >= 1 (inside a delegated task) must not start tasks.
  Unparseable depth values fail closed.
- This server is never in a child's MCP server list. Config validation
  rejects it; the depth guard backs that up.
- Config is strict: unknown keys and invalid values stop the server at
  startup with an error that names the file. A missing file means defaults.
  Do not add silent fallbacks for invalid config.
- Default profile: `auto` permission mode, `setting_sources:
  ["project","local"]`, no MCP servers, empty personal hooks and skills.
  `auto` always runs with `--permission-prompts none`. If the `system/init`
  event reports another permission mode, the task fails at once (no silent
  fallback to `default`).
- The state dir is private: a real directory (not a symlink), owned by the
  current user, mode 0700.
- One active `claude` process per session. The CLI does not lock sessions;
  the runner must.
- Do not delete a task's worktree while the task can still be resumed:
  sessions are keyed by cwd.
- On cancel, timeout, or cap, terminate the complete process group
  (`SIGINT`, then `SIGTERM`, then `SIGKILL` with a grace period).
- Errors returned to MCP clients are redacted and capped
  (`sanitizeForClient`). Full diagnostics go to stderr as JSON lines, never
  to stdout (stdout is the MCP transport).
- Keep every resource bounded: time caps, output and event-file caps, config
  size cap.

## Testing guidance

`npm test` is the default check for code changes. It builds first, then runs
the offline Node test suite. Offline tests use the fake `claude` and never
need a network or a login.

Live tests are opt-in (`npm run test:live`) and must stay tiny: use `sonnet`
for anything that needs `auto` mode (it falls back with `haiku`), `haiku`
otherwise.

Docs-only changes do not need code tests unless they change command
examples, public behavior, or CI expectations.

## Change hygiene

- One PR per build step or concern. Draft PR, squash merge when green.
- Update tests when behavior changes.
- Update this file and `docs/DESIGN-v2.md` when an invariant, tool contract,
  command, or operational expectation changes.
- Update `CHANGELOG.md` under `## [Unreleased]` for public-facing changes.
- Do not add runtime dependencies beyond `@modelcontextprotocol/sdk` and
  `zod` without prior discussion. Justify dev dependency additions.
- Do not add `AGENTS.md` to `package.json` `files` unless the npm package is
  intentionally changed to ship this guide.
