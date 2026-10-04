# AGENTS.md

Canonical public guide for AI agents and contributors working in this repository.

## Project purpose

`claudecode-mcp` v2 is an MCP server (stdio by default, HTTP with `--http`) that runs Claude Code as an **async
task runner**. Any MCP client can hand coding work or a review to Claude Code,
track progress, steer it, and collect the result.

`docs/DESIGN-v2.md` is the source of truth for the v2 design. Read it before
changing behavior. v2 is built in steps (design section 10), one PR per step.
v1 (one-shot `claude_prompt*` tools) was removed in step 1. The project is
installed from source and is not published to npm (`"private": true`).

Build status: all build steps (1-7) are done; 2.0.0 is on `main`. No npm
package (decision recorded in `docs/DESIGN-v2.md` section 10). Current work: network mode (HTTP over the tailnet on a Proxmox
VM), steps N1–N5 in `docs/DESIGN-v2.md` section 12. The 12.8 decisions are
taken; N1 (HTTP transport and auth), N2 (repos by URL), and N3 (results
out: push + draft PRs) are done; N4 (VM deploy doc and systemd unit) is
next. The server exposes `start_task` (worktree by default, or
in_place), `get_task`, `wait_task`, `get_events`, `send_message`,
`get_diff`, `cancel_task`, `close_task`, `list_tasks`, and `ask`.

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

- `src/cli.ts` - package entry (`bin`). No args starts the stdio MCP server;
  `--http` the HTTP server; `token add|list|revoke` manages HTTP tokens;
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
- `src/server.ts` - MCP server: startup (`prepare`), the shared
  `TaskService` with background work (`createTaskService`), tool schemas and
  registration (`createServer`), stdio entry (`serve`).
- `src/http.ts` - HTTP mode: loopback listener, Host/Origin/token checks,
  body cap, one stateless `McpServer` per request, graceful shutdown.
- `src/http-tokens.ts` - per-device token file (hashes, 0600) and lookup.
- `src/service.ts` - the task operations behind the tools (`TaskService`).
- `src/compact.ts` - compact steps and event pages from events.jsonl.
- `src/repo.ts` - `repo` path checks against `allowed_roots` (realpath).
- `src/repo-url.ts` - `repo_url` parsing, normalization, allowlist matching.
- `src/workspaces.ts` - managed clones (clone/fetch, remote base refs, ask
  worktrees, `prune-workspaces`).
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
- HTTP tokens: `http-tokens.json` next to the config file, or
  `http.tokens_file`. Hashes only; mode 0600.
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
- A caller's `repo_url` must parse (`parseRepoUrl`) and match a `repo_urls`
  pattern before anything is cloned or fetched. Only https and ssh (scp-like
  included) are accepted; `file://` only with the test switch
  `CLAUDECODE_MCP_ALLOW_FILE_URLS=1`. Clone and fetch run with
  `GIT_ALLOW_PROTOCOL`, `--no-recurse-submodules`, and `--` before the URL.
- Managed clones live under `workspaces_dir`, which must be inside
  `allowed_roots`, at `<scheme>_<host>/<owner>/<repo>.git` (`cloneSegments`;
  clones never nest). Clone, fetch, worktree creation, and prune for one
  repo run under `withRepoLock` (`<workspaces_dir>/.locks`). `repo_url`
  tasks never run `in_place`. Before a fetch, the clone's
  `claudecode-mcp.managed` marker and `origin` URL must match the request.
  `prune-workspaces` never touches a folder without the marker and never
  drops worktrees or (without `--force`) unpushed commits.
- Only the server pushes. `GH_TOKEN`/`GITHUB_TOKEN` stay out of the child
  env allowlist and are stripped from every git/gh process unless the call
  passes `keepTokens` (managed-clone clone/fetch/push, and gh). Those calls
  use `remoteConfigArgs` (no hooks, no fsmonitor, credential helpers cleared
  before gh). A `repo_url` push runs under the repo lock, re-checks the
  clone's origin (`assertCloneOrigin`), refuses local remote rewrites
  (`assertNoRemoteRewrites`), and pushes only the task branch to the
  verified URL. gh for a managed clone runs outside it with `--repo`.
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
- HTTP mode listens on loopback only (`http.host` cannot be anything else).
  Every request except `GET /healthz` passes the Host check, the Origin
  check, and a bearer token, in that order, before anything else is read.
  Tokens are stored only as SHA-256 hashes in a private (0600, own user,
  not a symlink, read through one `O_NOFOLLOW` descriptor) file whose folder
  only its owner or root can change. They are compared in constant time and
  never logged. The server re-reads the file on every request; an unsafe,
  missing, or broken file accepts no token (fail closed). `token add` and
  `token revoke` hold `<file>.lock`. Error answers close the connection.
  Request bodies are capped (`MAX_BODY_BYTES`).
- HTTP mode creates one `TaskService` per process (`createTaskService`) and
  one `McpServer` per request. Never start recovery or the dispatcher per
  request. `--http` and the `token` commands refuse to run at depth >= 1 (a task
  could otherwise mint a token and reach a depth-0 server over loopback).
  Background work starts only after the port is bound.

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
