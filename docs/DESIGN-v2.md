# claudecode-mcp v2 — design

Status: **draft for review**. No code changes yet.

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
  - enforces the time cap and stall check, and handles interrupt and cancel
    (SIGINT, then SIGTERM/SIGKILL to the process group);
  - restarts `claude` with `--resume` for a queued message after a turn ended.
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
    runner.pid
    runner.sock
```

### Worktrees

- Default: `git worktree add <repo>/.claude/worktrees/<task-id> -b claude/<slug>-<short-id> <base_ref>`.
- `isolation: "in_place"` runs in the given directory with no worktree (for
  reviews or non-git folders).
- Worktrees stay until `close_task`, because removing them breaks resume.
- `close_task` options: `keep_branch` (default: remove the folder, keep the
  branch), `delete` (remove both; refuses if there are unmerged commits unless
  `force`), `push_pr` (push the branch and open a draft PR with `gh`, if
  available).
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
| `ask` (convenience) | `prompt`, `repo?`, `profile?`, `model?`, `effort?`, `timeout_s?` | final text. Blocking, `in_place`, closed after. For quick reviews. |

**Steering.** `send_message` without `interrupt` goes into the running turn
(the test showed Claude handles it in the same turn). If the task is idle, the
runner resumes the session with the message. With `interrupt: true`, the runner
sends SIGINT, waits for the final result event, then resumes with the message.

**Result of a finished turn.** Claude's final text, `output_schema` result (from
`structured_output`) when given, branch, diff stat, turns, duration, token
usage, `permission_denials`, and `total_cost_usd` (estimate only on a subscription).

### Task states

`starting` → `running` ⇄ `idle` (turn done, waiting for messages) → `closed`.
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
  "default_profile": "worker",
  "profiles": {
    "worker": {
      "permission_mode": "auto",
      "setting_sources": ["project", "local"],
      "mcp_servers": {},
      "personal_hooks": ["PostToolUse:format-on-edit"],
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

- **Hooks:** `personal_hooks` lists entries as `<Event>:<id>` (or an index).
  At task start the server reads `~/.claude/settings.json`, copies only those
  hook entries into a generated settings file, and passes it with
  `--settings`. Hooks that send notifications or block on `Stop` should not be
  picked.
- **Skills:** `personal_skills` lists folder names under `~/.claude/skills`.
  The server builds a small plugin folder (manifest + links to the chosen
  skill folders) in the state dir and passes it with `--plugin-dir`. Skills
  loaded this way may show with a plugin prefix (for example
  `claudecode-personal:commit-style`).
- A `list_personal_config` helper (CLI command, not an MCP tool) prints the
  available hook entries and skill names, to make filling the config easy.

To verify in build step 5: the exact hook-entry naming, and that
`--setting-sources project,local` does not load `~/.claude/skills` on its own.

## 7. Human take-over

`get_task` returns a ready command: `cd <workdir> && claude --resume <session_id>`.
If a runner is active, the server first asks to pause the task (`cancel_task`
with `keep_session`), so two processes never write to one session. Optional
later: run the runner inside tmux (`claude --tmux` exists) for a live view.

## 8. Limits and safety

- `max_concurrent` running tasks (default 3). More tasks wait as `queued`.
- 2 h cap, 10 min stall flag, output and event-file size caps.
- `repo` must be inside `allowed_roots`.
- Rate limits: store the latest `rate_limit_event`. Show 5-hour utilization in
  `get_task`; if rejected, set `rate_limited` with the reset time.
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
   Node 22+, CI update.
2. Runner: spawn `claude -p` stream-json, events file, socket, interrupt,
   cancel, caps, stall check.
3. Core tools: `start_task` (`in_place` only), `get_task`, `wait_task`,
   `get_events`, `send_message`, `cancel_task`, `list_tasks`, `ask`.
4. Worktrees: `isolation: "worktree"`, `get_diff`, `close_task`.
5. Profiles (section 6).
6. Restart recovery, `interrupted` state, `max_concurrent` queue, rate-limit
   state.
7. Docs, live tests, 2.0.0 release prep.

Tests: offline tests use a fake `claude` that emits stream-json; live tests
(opt-in) use `haiku` with tiny prompts.

## 11. Open questions

1. Does `--setting-sources project,local` also stop user-level skills in
   `~/.claude/skills`? Verify in step 5; if not, use `--disable-slash-commands`,
   `plugin_dirs`, or `config_dir`.
2. When the runner closes the child's stdin mid-turn, does `claude -p` finish
   the turn or abort? (Matters for runner restarts.) Verify in step 2.
3. Public release: check Anthropic's current terms for using a subscription
   login through third-party tools before publishing.
4. Should `push_pr` use `gh`, or only push the branch?
5. For a public release: `auto` may not be on every plan. Keep the
   init-event mode check and a clear error so users can pick another profile.
