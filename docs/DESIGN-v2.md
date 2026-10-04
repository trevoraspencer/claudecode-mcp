# claudecode-mcp v2 — design

Status: **approved and built**. 2.0.0 is on `main`, installed from source
(no npm package; see section 10). Next: network mode on a dedicated VM, planned in
section 12 (not built).

## 1. Goal

Turn `claudecode-mcp` from a one-shot prompt wrapper into a **task runner**:
any MCP client can hand coding work or a review to Claude Code, track it, steer
it, and collect the result.

Main uses:

- **Delegate coding work.** Claude edits files and runs commands in a repo.
- **Second opinion / review.** Of anything the calling agent passes: a diff, a
  branch, files, a PR, or plain text.

Audience: the author first; publish later. Platforms: macOS and Linux. No
Windows.

### Non-goals (v2)

- Driving the interactive TUI (no screen-scraping, no `tmux send-keys`).
- A UI for humans. A human can take over a task with `claude --resume` (see 7).
- Windows support.

## 2. Decisions from the interview

| Topic | Decision |
|---|---|
| Caller | Any MCP client |
| Call style | Async tasks: start, then status / wait / message / cancel |
| Sessions | Persistent and resumable (drops the v1 "no sessions" rule) |
| Progress | For the calling agent (structured), not a live human view |
| Durability | Tasks survive an MCP server restart |
| Workspace | Git worktree per task by default; in-place option |
| Permissions | `auto` mode by default (a safety check decides each action); `bypassPermissions` per profile (see 6.1) |
| Parallelism | Several tasks at once, with a cap |
| Auth | Pro/Max subscription via the user's own `claude` login |
| Time limits | Long cap (2 h) plus stall detection (10 min without events) |
| Model / effort | Caller picks per task; otherwise CLI default |
| User config | Server-owned **profiles**, separate from the personal setup (see 6) |
| MCP servers | Set per install in the server config; default none |
| Hooks / skills | Default: the target repo's own, plus a configurable set of personal hooks and skills (see 6.2) |
| Old code | Fresh rewrite; port the proven parts |
| Name | Keep `claudecode-mcp` |

## 3. Engine test results (CLI 2.1.287, Linux)

Two engines were tested: **A** = our own runner around `claude -p` with
`stream-json`; **B** = Claude Code's native background sessions
(`claude --bg`, `agents`, `attach`, `logs`, `stop`, `rm`).

| Need | A: `claude -p` stream-json | B: `claude --bg` |
|---|---|---|
| Start with a known session ID | Yes (`--session-id`) | No — ignored; must parse output |
| Structured progress | Yes — documented event stream | No — `logs` is raw terminal output; transcript files are an internal format |
| Resume a conversation | Yes (`--resume`, memory kept) | Yes |
| Message while running | Yes — `--input-format stream-json`; a mid-run message is handled in the same turn | No — `--bg --resume` on a live session starts a **copy** in another directory |
| Interrupt | Yes — SIGINT stops in ~2 s, kills the tool's child process, emits a final `error_during_execution` result; the session resumes cleanly and knows it was cut off | `claude stop` |
| Survives parent exit | Yes, when started detached | Yes |
| Worktree management | We do it with `git worktree` | Built in; `rm` refuses to delete uncommitted work |
| Setup friction | None found: ran in an untrusted folder | Needs a trust prompt per folder, and a one-time interactive disclaimer for `bypassPermissions` |
| Rate-limit info | Yes — `rate_limit_event` with 5-hour and 7-day utilization | Not exposed |

Other findings:

- **Two processes can resume the same session at once.** The CLI does not lock.
  The server must allow only one active process per session.
- Sessions from `claude -p` are saved under `~/.claude/projects/<cwd>/`, keyed
  by the working directory. **Deleting a worktree breaks resume.**
- The CLI refuses plain long `sleep` commands. Not a problem for real work.
- Hosted-container env vars (for example `CLAUDE_AUTO_BACKGROUND_TASKS`) change
  child behavior. The env allowlist must keep them out.
- **`auto` permission mode works headless** with `sonnet` and `opus`
  (`--permission-mode auto --permission-prompts none`). It ran normal edits,
  commits, and a force-push to a throwaway local remote without prompts.
- **`auto` silently falls back to `default` with `haiku`.** No error; the
  `system/init` event reports `permissionMode: "default"`. Headless, `default`
  denies anything that would need a prompt.
- Follow-up probe (CLI 2.1.288, build step 2):
  - With stdin left open, `claude -p` stream-json **stays alive after a
    turn**; the next user message starts a new turn in the same process. Each
    turn emits its own `system/init`.
  - Closing stdin mid-turn lets the turn **finish**, then the process exits 0.
  - **SIGINT ends the process** (after the `error_during_execution` result).
    The stream-json `control_request` `{"subtype":"interrupt"}` ends the turn
    and **keeps the process**. The runner uses the control request and falls
    back to SIGINT + `--resume`.
- With no profile isolation, the child **inherited the host's personal
  instructions** (it added commit trailers "as the session instructions
  require"). This confirms the need for profiles.

**Decision: engine A.** B has nice human features (`attach`), but it fails two
hard needs: structured progress and messaging a live task.

## 4. Architecture

```
MCP client ──stdio──▶ claudecode-mcp (server)
                          │  unix socket per task
                          ▼
                     runner (detached, 1 per task)
                          │  stdin: stream-json messages
                          ▼  stdout: stream-json events → events.jsonl
                     claude -p (in the task's worktree)
```

- **Server** (`claudecode-mcp`): stdio MCP server. Thin. It starts runners,
  reads task state from disk, and forwards messages. It holds no task state in
  memory that matters.
- **Runner** (`claudecode-mcp runner <task-id>`, same package): a small detached
  Node process (`setsid`), one per task. It:
  - starts `claude -p --input-format stream-json --output-format stream-json
    --verbose` with the profile's flags;
  - owns the child's stdin and accepts messages on `runner.sock`;
  - appends every event to `events.jsonl` and updates `task.json`;
  - enforces the per-turn time cap, the stall check, and the event-log cap;
  - interrupts with a stream-json `control_request` (fallback: SIGINT, then
    restart with `--resume`); stops with SIGINT, then SIGTERM/SIGKILL to the
    process group;
  - keeps `claude` alive while idle for `idle_minutes` (default 15), then
    closes stdin and exits. A later message starts a new runner that resumes
    the session with `--resume`.
  - holds a per-session lock file (`sessions/<session-id>.lock`) so only one
    process ever drives a session.
- Because runners are detached, **tasks keep running when the MCP server
  restarts**. A new server finds them on disk and reconnects by socket.
- If a runner dies (reboot, crash), the task becomes `interrupted`. The
  conversation is still on disk, so `send_message` resumes it.

### State on disk

```
$XDG_STATE_HOME/claudecode-mcp/          (default ~/.local/state/claudecode-mcp)
  tasks/<task-id>/
    task.json       status, session_id, workdir, branch, profile, model,
                    usage, timestamps, last rate-limit info
    events.jsonl    raw stream-json events (the transcript)
    runner.log      the runner's own stderr
    runner.sock     NDJSON requests: status, message, cancel
  sessions/<session-id>.lock
```

### Worktrees

- Default: `git worktree add <repo>/.claude/worktrees/<task-id> -b claude/<slug>-<short-id> <base_ref>`.
  `base_ref` defaults to the repo's `HEAD` commit (uncommitted changes in the
  main checkout are not included). `/.claude/worktrees/` is added to the
  repo's local `.git/info/exclude` so worktrees never show in `git status`.
  A `repo` that names a subfolder starts Claude in the same subfolder of the
  worktree. A non-git `repo` is an error that suggests `in_place`. The repo's
  top level must also be inside `allowed_roots` (the worktree mirrors the
  whole repo). A linked worktree (for example another task's) cannot be the
  `repo` of a worktree task, and a repo with no commits needs `in_place`.
- `isolation: "in_place"` runs in the given directory with no worktree (for
  reviews or non-git folders).
- Worktrees stay until `close_task`, because removing them breaks resume.
- `close_task` options: `keep_branch` (default: remove the folder, keep the
  branch), `delete` (remove both; refuses if the branch has commits not in
  the repo's `HEAD` unless `force`), `push_pr` (`git push -u origin <branch>`,
  then `gh pr create --draft` if `gh` is available, else a note; then remove
  the folder). Unless `force`, every action refuses uncommitted changes and
  a worktree whose `HEAD` left the task branch (commits there would be
  lost). It always refuses while other worktrees sit inside the task's
  folder. Ignored files removed with the folder are listed in `notes`. A
  closed task cannot be resumed.
- `get_diff` compares the working tree with the base commit: commits, diff
  stat, untracked files (as new files), and the diff capped at 200 KiB.
  `in_place` tasks in a git repo record `HEAD` at start as their base, so
  their diff also includes any changes that were already uncommitted.
- Idle tasks older than a configurable TTL (default 7 days) are listed as
  stale. They are never deleted automatically if they have uncommitted or
  unpushed work.

## 5. MCP tools

| Tool | Input | Returns |
|---|---|---|
| `start_task` | `prompt`, `repo` (path), `isolation?` (`worktree` \| `in_place`), `base_ref?`, `profile?`, `model?`, `effort?`, `system_prompt?`, `output_schema?`, `max_minutes?`, `name?` | `task_id`, `session_id`, `workdir`, `branch`, `status` |
| `send_message` | `task_id`, `text`, `interrupt?` | delivered now / queued / resumed |
| `get_task` | `task_id`, `recent?` (N steps) | status, last activity, recent steps (compact), result, usage, rate-limit info |
| `wait_task` | `task_id`, `timeout_s?` (default 30, max under client timeouts) | same as `get_task`, when the task is idle/finished or time runs out |
| `get_events` | `task_id`, `cursor?`, `limit?` | compact events page + next cursor |
| `get_diff` | `task_id`, `stat_only?` | diff stat, or full diff vs. `base_ref` (capped) |
| `cancel_task` | `task_id` | final status |
| `list_tasks` | `status?`, `repo?` | task summaries |
| `close_task` | `task_id`, `action?`, `force?` | what was removed / pushed |
| `ask` (convenience) | `prompt`, `repo?`, `profile?`, `model?`, `effort?`, `timeout_s?`, `writable?` | final text. Blocking, `in_place`, closed after. For quick reviews. |

**`ask` details (step 3).** Read-only unless `writable: true`: permission mode
`plan` plus blocked `Edit`, `Write`, `NotebookEdit` (plan mode alone still
writes a plan file under `~/.claude/plans`). Plan mode works headless with
`haiku`, so cheap reviews need no `auto`-capable model. Without `repo` it
runs in a fresh empty temp folder, removed afterwards. `timeout_s` default
300, max 600, with MCP progress notifications. `wait_task` caps `timeout_s` at
50 so calls stay under common 60 s client timeouts; callers loop. The task
record is kept as `closed` for audit.

Probe (step 3): in a folder that was never trusted interactively, headless
`claude` **ignores** the project's `permissions.allow` entries (it says so on
stderr), and plan mode refused a `touch` even with `Bash(*)` allowed. Not yet
verified: plan mode in a *trusted* repo with broad allow rules (see open
question 6).

**Steering.** `send_message` without `interrupt` goes into the running turn
(the test showed Claude handles it in the same turn). If the task is idle, the
runner resumes the session with the message. With `interrupt: true`, the runner
sends SIGINT, waits for the final result event, then resumes with the message.

**Result of a finished turn.** Claude's final text, `output_schema` result (from
`structured_output`) when given, branch, diff stat, turns, duration, token
usage, `permission_denials`, and `total_cost_usd` (estimate only on a subscription).

### Task states

(`queued` →) `starting` → `running` ⇄ `idle` (turn done, waiting for messages) →
`closing` → `closed`. `closing` is set once `close_task`'s checks pass and
before any slow step (push, folder removal), so the task can never be
resumed into a folder that is going away; if a step fails, the task stays
`closing` and `close_task` can be called again.
Side states: `stalled` (no events for N min, still alive), `interrupted`
(runner gone), `failed`, `rate_limited` (from `rate_limit_event` or an error;
includes the reset time), `timed_out`, `cancelled`.

## 6. Profiles: separate setup from your personal Claude Code

The child Claude can use a setup that is different from your personal one. Each
task picks a **profile** from the server config. A profile maps to CLI flags:

| Profile field | CLI flag | Effect |
|---|---|---|
| `setting_sources` | `--setting-sources` | e.g. `["project","local"]` drops `~/.claude/settings.json` (your hooks, permissions, plugins) |
| `settings` | `--settings <file>` | the profile's own hooks, permission deny rules, env |
| `mcp_servers` | `--strict-mcp-config --mcp-config <json>` | **exact** MCP server list; personal servers ignored |
| `permission_mode` | `--permission-mode` | `auto` (default) or `bypassPermissions` |
| `disallowed_tools` | `--disallowedTools` | extra hard blocks, e.g. `mcp__gmail__send_message` |
| `tools` | `--tools` | allow only these built-in tools |
| `plugin_dirs` | `--plugin-dir` | load only these plugins (and their skills) |
| `skills` | `--disable-slash-commands` when `false` | turn all skills off |
| `personal_hooks` | merged into a generated `--settings` file | chosen hook entries from `~/.claude/settings.json` (see 6.2) |
| `personal_skills` | generated `--plugin-dir` | chosen skills from `~/.claude/skills` (see 6.2) |
| `config_dir` | `CLAUDE_CONFIG_DIR` env | fully separate Claude home (own settings, skills, sessions). Needs its own login or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` |
| `model`, `effort` | `--model`, `--effort` | defaults; the caller can override |

Example `~/.config/claudecode-mcp/config.json`:

```json
{
  "allowed_roots": ["~/code"],
  "max_concurrent": 3,
  "max_minutes": 120,
  "stall_minutes": 10,
  "idle_minutes": 15,
  "max_events_mb": 100,
  "default_profile": "worker",
  "profiles": {
    "worker": {
      "permission_mode": "auto",
      "setting_sources": ["project", "local"],
      "mcp_servers": {},
      "personal_hooks": ["PostToolUse:0"],
      "personal_skills": ["commit-style", "test-runner"]
    },
    "worker-github": {
      "permission_mode": "auto",
      "setting_sources": ["project", "local"],
      "mcp_servers": { "github": { "command": "github-mcp-server", "args": ["stdio"] } }
    },
    "reviewer-clean": {
      "permission_mode": "auto",
      "setting_sources": ["project"],
      "mcp_servers": {},
      "skills": false
    },
    "personal": {
      "permission_mode": "bypassPermissions",
      "setting_sources": ["user", "project", "local"],
      "inherit_user_mcp": true
    }
  }
}
```

Always on, for every profile:

- This server is never in the child's MCP list.
- **Depth guard:** the runner sets `CLAUDECODE_MCP_DEPTH=1`. If the server
  starts with depth ≥ 1, its task tools refuse to run. No recursive fan-out.
- The env allowlist from v1 stays (extended with profile `env`). Host-specific
  vars like `CLAUDECODE` and `CLAUDE_AUTO_BACKGROUND_TASKS` are never passed.

Defaults when the config file has no profiles: one `worker` profile with
`auto` mode, no MCP servers, the target repo's own settings, hooks, and skills
(`setting_sources: ["project", "local"]`), and empty `personal_hooks` /
`personal_skills` lists for the user to fill.

### 6.1 Permissions: `auto` mode

- Default `permission_mode` is `auto`, always with `--permission-prompts none`
  so nothing can hang waiting for a person.
- `auto`'s built-in rules block high-risk actions: production deploys,
  sending private data outside trusted repos, destructive git on shared
  history, mass deletes, publishing packages, weakening security, and more
  (`claude auto-mode defaults` prints them). Rules can be tuned in the
  profile's `settings` (`autoMode` section).
- `auto` is the default mode for all of the user's Claude Code sessions, so it
  is available on their plan. It needs `sonnet` or `opus`. The runner reads `permissionMode` from the
  `system/init` event; if it is not the requested mode, the task fails at once
  with a clear error (no silent fallback).
- Blocked actions are listed in the result (`permission_denials`), so the
  caller can see what was refused and decide what to do.
- `bypassPermissions` stays available per profile for full power.

### 6.2 Picking personal hooks and skills

The user's full personal setup is not loaded, but chosen parts of it can be:

- **Hooks:** `personal_hooks` lists entries as `<Event>:<index>` (Claude Code
  hook entries have no id). At task start the server reads the personal
  `settings.json` (`$CLAUDE_CONFIG_DIR` or `~/.claude`), copies only those
  hook entries into `tasks/<id>/settings.json` (merged with the profile's own
  `settings`), and passes it with `--settings`. Hooks that send
  notifications or block on `Stop` should not be picked. Indexes are
  positional: after adding or reordering hooks in `settings.json`, re-run
  `claudecode-mcp list-personal-config` and update the profile. The generated
  settings are a snapshot taken when the task is created.
- Settings `env` (inline, a settings file, or user settings when the profile
  loads the `user` source) may not set reserved variables
  (`CLAUDECODE_MCP_DEPTH`, host-session markers): Claude Code applies that
  `env` to itself and its children, so it could reset the depth guard.
- **Skills:** `personal_skills` lists folder names under the personal
  `skills` dir. The server builds `tasks/<id>/personal-plugin` (manifest +
  symlinks to the chosen skill folders) and passes its **absolute** path
  with `--plugin-dir` (a relative path does not load). Skills show with the
  plugin prefix, e.g. `claudecode-personal:commit-style` (verified live).
- A profile that names a missing hook, skill, plugin dir, settings file, or
  `config_dir` stops the server at startup, and is checked again at task
  start. A `config_dir` profile also needs `claude auth status` to report a
  login there, or the task is refused before anything is created.
- A `list_personal_config` helper (CLI command, not an MCP tool) prints the
  available hook entries and skill names, to make filling the config easy.

Verified in build step 5 (CLI 2.1.288): `--setting-sources project,local`
does **not** load `~/.claude/skills` (only built-in skills), and
`--disable-slash-commands` turns off all skills. Empty setting sources also
drop the repo's CLAUDE.md, so profiles that want repo memory need `project`.

## 7. Human take-over

`get_task` returns a ready command: `cd <workdir> && claude --resume <session_id>`.
If a runner is active, the server first asks to pause the task (`cancel_task`
with `keep_session`), so two processes never write to one session. Optional
later: run the runner inside tmux (`claude --tmux` exists) for a live view.

## 8. Limits and safety

- `max_concurrent` running tasks (default 3). The cap counts tasks with a
  turn in progress (or a runner being launched); idle runners do not use a
  slot, and a message to a live idle runner starts its turn directly. So
  steering an idle task can briefly exceed the cap (and a rate-limit hold);
  this is accepted, since that `claude` process is already running. A new
  runner beyond the cap (`start_task`, `ask`, or a `send_message` that must
  resume) leaves the task `queued` on disk. Every server runs a dispatcher
  (every 2 s, `CLAUDECODE_MCP_DISPATCH_MS`) under a global `dispatch.lock`
  that starts queued tasks oldest first. New work always enters the queue
  first and then triggers a dispatch, so nothing jumps the line, and a
  dispatch that cannot run now leaves the task queued for the next tick. `get_task` shows the queue
  position. `wait_task` and `ask` wait through the queue.
- Restart recovery: at startup a server marks tasks `interrupted` whose
  recorded runner is dead (or started before the last boot), and tasks left
  `starting` for over a minute with no runner or launch. Their session and
  pending messages stay; `send_message` resumes them.
- 2 h cap **per turn** (idle time does not count), 10 min stall flag, and an
  event-file cap (`max_events_mb`, default 100). Reaching the event cap stops
  the task as `failed`; the log is never silently truncated.
- `repo` must be inside `allowed_roots`.
- Rate limits: store the latest `rate_limit_event`. `get_task` shows
  `rate_limit_summary` (status, 5-hour and 7-day utilization, reset time). A
  turn that ends in error while the latest status is `rejected` leaves the
  task `rate_limited`. The newest rate-limit report across tasks (all
  share one account) decides: while it is an unexpired rejection, the
  dispatcher starts nothing and queued tasks show `hold_until`; a later
  `allowed` report clears it.
- Client-facing errors stay redacted and capped (port from v1).

## 9. Keep / drop from v1

**Keep (port):** env allowlist and dangerous-var stripping, process-group kill
with SIGTERM→SIGKILL grace, secret redaction, prompt via stdin, structured
stderr logging, `DEBUG=claudecode-mcp`.

**Drop:** `claude_prompt*` tools (replaced by `ask` and tasks), the file-context
tool and its path guard (Claude reads files itself), loose JSON recovery
(stream-json is line-based), the `--help` flag probe (require a minimum CLI
version instead), Windows command-line logic, `skill.sh`, Node 20.

Release as **2.0.0** (breaking). Rewrite `AGENTS.md` invariants to match.

## 10. Build plan (one PR each)

1. Skeleton: config loading, state dir, env allowlist port, depth guard,
   Node 22+, CI update. **Done.** Decisions: v1 removed in this step; config
   validated with `zod` (strict, unknown keys fail); `allowed_roots` defaults
   to the home dir; CI on Node 22 and 24.
2. Runner: spawn `claude -p` stream-json, events file, socket, interrupt,
   cancel, caps, stall check. **Done.** Decisions: idle runners keep `claude`
   alive for `idle_minutes`, then exit; `max_minutes` is per turn; the event
   cap stops the task.
3. Core tools: `start_task` (`in_place` only), `get_task`, `wait_task`,
   `get_events`, `send_message`, `cancel_task`, `list_tasks`, `ask`.
   **Done.** Decisions: `ask` without `repo` uses an empty temp folder;
   `ask` is read-only by default; `wait_task` max 50 s, `ask` max 600 s;
   `max_concurrent` is not enforced until step 6.
4. Worktrees: `isolation: "worktree"`, `get_diff`, `close_task`. **Done.**
   Decisions: worktrees under `<repo>/.claude/worktrees/` with a local
   exclude entry; non-git repos error (suggest `in_place`); `push_pr` pushes
   and opens a draft PR with `gh` when available; closing refuses
   uncommitted changes unless `force`.
5. Profiles (section 6). **Done.** Decisions (taken with the recommended
   defaults when the session asked and got no answer): hooks are named
   `<Event>:<index>`; broken references fail at startup and at task start;
   open question 6 was probed without touching `~/.claude.json` (see below).
6. Restart recovery, `interrupted` state, `max_concurrent` queue, rate-limit
   state. **Done.** Decisions (recommended defaults, no answer requested as
   the session was told to continue): the cap counts active turns, not idle
   runners; queued state lives on disk; any server dispatches; a live
   rejection holds the whole queue.
7. Docs, live tests, 2.0.0 release prep. **Done:** README rewritten for v2,
   `examples/config.example.json` (tested against the schema, as are the
   README config blocks), a live interrupt test, version 2.0.0, and the
   CHANGELOG `[2.0.0]` section.

**Release decision (2026-10-04):** no npm package. The maintainer does not
need claudecode-mcp published; it is installed from source (clone, `npm ci`,
`npm run build`, register `dist/cli.js`). `package.json` is marked
`"private": true` so `npm publish` refuses. Version 2.0.0 on `main` is the
release; a `v2.0.0` git tag is optional and only runs the Release
validation workflow.

Tests: offline tests use a fake `claude` that emits stream-json; live tests
(opt-in) use tiny prompts: `sonnet` for anything that needs `auto` mode,
`haiku` otherwise.

## 11. Open questions

1. ~~Does `--setting-sources project,local` also stop user-level skills in
   `~/.claude/skills`?~~ Yes (step 5 probe).
2. ~~When the runner closes the child's stdin mid-turn, does `claude -p`
   finish the turn or abort?~~ It finishes the turn, then exits (step 2 probe).
3. ~~Public release: check Anthropic's current terms for using a
   subscription login through third-party tools before publishing.~~ Moot:
   no public release (2026-10-04). Revisit only if publishing comes back.
4. ~~Should `push_pr` use `gh`, or only push the branch?~~ Both: push, then
   `gh pr create --draft` when `gh` is available (step 4).
5. If it is ever shared: `auto` may not be on every plan. Keep the
   init-event mode check and a clear error so users can pick another profile.
6. In a trusted repo whose `.claude/settings.json` allows `Bash(*)`, does
   plan mode still refuse state-changing commands? If not, read-only `ask`
   must also drop project settings or block `Bash`. Step 5 probe: with
   `Bash(*)` allowed through `--settings` (which needs no trust), both haiku
   and sonnet in plan mode refused to run `touch`; neither even called Bash.
   So the permission engine itself was not exercised. Accepted risk: read-only
   `ask` keeps project settings, because dropping them also drops the repo's
   CLAUDE.md. Revisit if a model is seen running state-changing Bash in plan
   mode.

## 12. Network mode: a dedicated VM on the tailnet (plan, not built)

Status: **planned 2026-10-04, not built.** To be executed in a new session,
one PR per step (N1–N5), each with an independent review before merge, as in
section 10. Start with the open decisions in 12.8.

### 12.1 Goal

Run claudecode-mcp on a dedicated Proxmox VM and call it over the network
from any machine on the Tailscale tailnet. Keep the local stdio install
working unchanged on development machines. The VM is the sandbox: tasks run
there, on repos cloned there, with their own credentials.

```
dev machine (MCP client) ──HTTPS (tailnet)──▶ tailscale serve on VM
                                                │ http://127.0.0.1:8787/mcp
                                                ▼
                                   claudecode-mcp --http (systemd)
                                                │ (unchanged from here)
                                                ▼
                                     runners ─▶ claude -p ─▶ worktrees
```

### 12.2 Decisions so far (2026-10-04)

| Topic | Decision |
|---|---|
| Exposure | Server listens on `127.0.0.1` only. `tailscale serve` publishes it as HTTPS on `https://<vm>.<tailnet>.ts.net` (tailnet-only, real certificate). Clients must also send a bearer token. |
| Repos | Cloned on demand by URL: `start_task` / `ask` accept `repo_url` (+ `base_ref`). The VM keeps one managed clone per repo and fetches before each task. Local installs keep using paths. |
| Results out | **Open** (12.8, decision 1). |
| Local install | stdio stays the default mode; nothing changes for local use. |

### 12.3 Verified facts

- MCP SDK 1.29 ships `StreamableHTTPServerTransport`
  (`@modelcontextprotocol/sdk/server/streamableHttp.js`) with
  `handleRequest(req, res, body)` on plain `node:http`: **no new runtime
  dependency**. It has DNS-rebinding options (`allowedHosts`,
  `allowedOrigins`).
- Claude Code registers remote servers with
  `claude mcp add --transport http <name> <url> --header "Authorization: Bearer <token>"`.
- Not yet verified (check in N1/N4): the exact `tailscale serve` syntax on the
  installed Tailscale version, and that systemd with `KillMode=process`
  keeps detached runners alive across a service restart (the default
  `control-group` would kill them, breaking "tasks survive a restart").

### 12.4 Step N1: HTTP transport and auth

- New mode: `claudecode-mcp --http` (stdio stays the default). Config keys:
  `http.host` (default `127.0.0.1`), `http.port` (default `8787`),
  `http.path` (default `/mcp`), `http.token_file` (default
  `~/.config/claudecode-mcp/http-token`, mode 0600, generated on first start
  if missing; never logged). Refuse to start in HTTP mode without a token.
- Bearer check with a constant-time compare on every request; 401 otherwise.
  Set `allowedHosts` to the tailnet name and localhost; reject browser
  `Origin`s. Request body cap (for example 8 MiB). `GET /healthz` (no auth,
  no details) for monitoring.
- Stateless Streamable HTTP (`sessionIdGenerator: undefined`): one
  `McpServer` + transport per request, sharing **one** `TaskService`, so the
  recovery and dispatcher background work runs once per process. `ask`
  progress notifications stream as SSE within the request.
- Graceful shutdown on SIGTERM: stop accepting, let in-flight requests
  finish (runners are untouched; they are separate processes).
- Depth guard and all invariants unchanged. Responses show VM paths.
- Tests: start the server on a random local port; auth required, wrong
  token 401, Host check, tools/list and one task end to end over HTTP,
  progress events for `ask`.

### 12.5 Step N2: repos by URL

- Config: `workspaces_dir` (default `~/claudecode-workspaces`; must be inside
  `allowed_roots`), `repo_urls`: allowlist patterns such as
  `["https://github.com/trevoraspencer/*", "git@github.com:trevoraspencer/*"]`.
  No pattern match, no clone: callers cannot make the VM fetch arbitrary
  code.
- `start_task` and `ask` accept `repo_url` instead of `repo` (exactly one of
  the two). The managed clone lives at
  `<workspaces_dir>/<host>/<owner>/<repo>`; first use clones, later uses
  `git fetch --prune` under a per-repo lock. `base_ref` defaults to the
  remote's default branch (`origin/HEAD`), not the clone's checkout. Then
  the worktree flow from step 4 applies unchanged.
- URL handling: parse and normalize; refuse `ext::`, `file://` outside
  tests, credentials embedded in URLs, and option-like values.
- `list_tasks` shows `repo_url` for such tasks. A `prune_workspaces` helper
  (CLI, not MCP) can remove clones with no open tasks.
- Tests: local bare repos as remotes (allowed by a test-only pattern).

### 12.6 Step N3: results out (after decision 1)

- If **push + draft PRs**: the VM holds a fine-grained GitHub token (or
  deploy keys) limited to the allowlisted repos; `gh auth login --with-token`
  on the VM; `close_task push_pr` works as built in step 4. Optionally
  restrict pushes to `claude/*` branches with a GitHub ruleset.
- If **branches only**: same credential, no `gh`; `push_pr` pushes and says
  so (already supported when `gh` is missing).
- If **no push**: results only via `get_diff`; disable `push_pr` in network
  mode with a clear error. Document how to apply a diff locally.

### 12.7 Steps N4–N5: VM deployment and client setup docs

- **N4 `docs/DEPLOY-proxmox.md`** plus `examples/claudecode-mcp.service`:
  VM size (2–4 vCPU, 8 GB RAM, 40 GB disk; Debian 13 or Ubuntu 24.04 LTS),
  a dedicated `claude` user, Node 22, `claude` CLI install, login with
  `claude setup-token` (long-lived `CLAUDE_CODE_OAUTH_TOKEN` in a 0600
  systemd `EnvironmentFile`) or `claude auth login` over SSH, git and `gh`
  credentials per decision 1, Tailscale install, `tailscale serve` command,
  systemd unit (`KillMode=process`, `Restart=on-failure`, `User=claude`),
  no public ports (host firewall), tailnet ACL limiting which devices may
  reach the VM, logs via `journalctl`, upgrades (`git pull && npm ci &&
  npm run build && systemctl restart`), and what to back up (config, token,
  state dir).
- **N5 client setup in the README:** register the VM on each dev machine
  (`claude mcp add --transport http claudecode-vm https://<vm>.<tailnet>.ts.net/mcp --header "Authorization: Bearer $(cat token)"`),
  keep a local stdio install side by side under another name
  (`claudecode-local`), and when to use which (VM: long or risky work,
  parallel tasks; local: quick reviews of local, uncommitted work).

### 12.8 Open decisions for the new session (ask first)

1. **Results out:** push branches + draft PRs (recommended: easiest review
   on GitHub), push branches only, or no push (diff text only).
2. **Token:** one shared token, or one token per client device (named, so
   one can be revoked)? Recommended: per-device tokens in a small JSON file.
3. **Extra identity check:** also require `tailscale serve`'s
   `Tailscale-User-Login` header to be on an allowlist? Recommended: optional
   config, off by default.
4. **Workspaces location and disk budget** on the VM (default
   `~/claudecode-workspaces`), and whether to prune old clones automatically.

### 12.9 Risks

- Anyone who can reach the endpoint with a token can run code on the VM
  through Claude in `auto` mode. Keep the VM single-purpose, keep tokens
  per device, and use tailnet ACLs.
- The subscription login lives on the VM; treat the VM disk as sensitive.
- Paths in responses are VM paths; callers must use `get_diff` or git to see
  results, not local file reads.
