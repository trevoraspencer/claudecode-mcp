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

Build status: steps 1-6 are done (skeleton, runner, core MCP tools,
worktrees, profiles, recovery and queue). The server exposes `start_task` (worktree by default, or
in_place), `get_task`, `wait_task`, `get_events`, `send_message`,
`get_diff`, `cancel_task`, `close_task`, `list_tasks`, and `ask`. Step 7
(docs, live tests, 2.0.0 release prep) is next.

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
  `runner <task-id>` runs one task's runner. Refuses Node < 22 and Windows.
- `src/runner.ts` - the detached per-task runner: owns the `claude` child,
  events.jsonl, task.json updates, the socket, timers, interrupt and stop.
- `src/launcher.ts` - server side of runners: `buildSpec`, `launchRunner`,
  `resumeTask`, `requestRunner`.
- `src/task-store.ts` - task ids, task.json shape, atomic writes.
- `src/session-lock.ts` - one process per session (lock file with PID).
- `src/claude-args.ts` - the `claude` argv (all flag decisions in one place).
- `src/profile.ts` - profile references (personal hooks and skills, plugin
  dirs, settings files, config_dir): checks and per-task generated files.
- `src/server.ts` - stdio MCP server: startup (`prepare`), tool schemas and
  registration.
- `src/service.ts` - the task operations behind the tools (`TaskService`).
- `src/compact.ts` - compact steps and event pages from events.jsonl.
- `src/repo.ts` - `repo` path checks against `allowed_roots` (realpath).
- `src/git.ts` - git/gh helpers: worktree create/remove, refs, dirty files.
- `src/diff.ts` - `get_diff` (commits, stat, untracked, capped diff).
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
- Personal Claude home (source of `personal_hooks` / `personal_skills`):
  `$CLAUDE_CONFIG_DIR` or `~/.claude`. `claudecode-mcp list-personal-config`
  prints what is available.

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
  - Settings `env` (profile `settings`, settings files, and user settings
    when the profile loads the `user` source) may not set reserved
    variables either; Claude Code applies it to the child and its tools.
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
  the runner takes `sessions/<session-id>.lock` before it starts `claude`.
- Start new runners only through the queue gate (`admit`, `dispatch`, or
  `resumeTask` under `withDispatchLock`) so `max_concurrent` holds across
  servers. Lock order is always dispatch, then launch; never take the
  dispatch lock while holding a launch lock.
- Start runners only under the task's launch lock (`withLaunchLock`,
  `tasks/<id>/launch.lock`), so concurrent calls never start two runners.
  A recorded runner counts as alive only if its PID is alive, started
  after the last boot, and (before replacing it) its socket answers.
- While a runner is alive it is the only writer of its task.json. The server
  writes task.json only to create a task or before launching a runner.
  Writes are atomic (temp file + rename).
- The runner talks to `claude` only through stream-json on stdin/stdout.
  Interrupt with a `control_request`; SIGINT ends the process (use it only
  as the fallback and to stop).
- The events log is never silently truncated: reaching `max_events_mb`
  stops the task as `failed`.
- `max_minutes` caps each turn, not idle time.
- Every task tool that can start or resume work calls
  `assertDepthAllowsTasks()` first.
- A caller's `repo` must resolve (realpath) to a directory inside
  `allowed_roots`.
- `ask` is read-only unless `writable: true` (plan mode plus blocked file
  tools). Without `repo` it runs in a fresh temp folder that is removed
  afterwards.
- `wait_task` never blocks longer than 50 s; `ask` never longer than 600 s.
- git and gh run with argv arrays, a timeout, `GIT_TERMINAL_PROMPT=0`, and
  no `GIT_DIR`-style redirect variables. Caller refs are validated.
- Never remove a worktree while its runner is alive, and never discard
  uncommitted work, unmerged commits, or commits off the task branch
  without `force`. Never remove a folder that contains other worktrees.
- `close_task` holds the launch lock and sets `closing` before any slow
  step; `closing` and `closed` tasks are never resumed.
- A worktree task's git top level must be inside `allowed_roots`, and it
  must be a main checkout, not a linked worktree.
- git/gh child processes run detached with stdin closed (no tty prompts) and
  `GIT_SSH_COMMAND` defaulting to `ssh -o BatchMode=yes`. Diffs use
  `--no-ext-diff --no-textconv`. Text sent to a remote (branch names, PR
  titles and bodies) is redacted first.
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
