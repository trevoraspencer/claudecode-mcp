# claudecode-mcp

[![CI](https://github.com/trevoraspencer/claudecode-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/trevoraspencer/claudecode-mcp/actions/workflows/ci.yml)

An MCP server that runs [Claude Code](https://code.claude.com) as an
**async task runner**. Any MCP client can hand coding work or a review to
Claude Code, track progress, steer it, and collect the result.

- Each task runs in its own git worktree and branch (or in place).
- Tasks are persistent sessions: they survive an MCP server restart and can
  be resumed later or taken over by hand with `claude --resume`.
- Several tasks run in parallel, up to a cap; the rest wait in a queue.
- A blocking `ask` tool gives quick, read-only reviews and answers.

The design and its decisions are in [`docs/DESIGN-v2.md`](docs/DESIGN-v2.md).
2.0 replaces the old 1.x one-shot `claude_prompt*` tools. It is installed
from source; it is not published to npm.

## Requirements

- macOS or Linux. No Windows.
- Node 22 or newer.
- The `claude` CLI, version **2.1.287 or newer**, on your `PATH` and logged
  in (`claude auth status`). A Pro or Max subscription login works; so do
  API keys and cloud providers. The server uses the `claude` login you
  already have.
- `git` for worktree tasks. `gh` (optional) for `close_task` draft PRs.

## Install

From source:

```sh
git clone https://github.com/trevoraspencer/claudecode-mcp.git
cd claudecode-mcp
npm ci
npm run build
```

Register it with your MCP client, using the absolute path to `dist/cli.js`.
For Claude Code:

```sh
claude mcp add claudecode -- node /absolute/path/to/claudecode-mcp/dist/cli.js
```

Or in a client's JSON config:

```json
{
  "mcpServers": {
    "claudecode": {
      "command": "node",
      "args": ["/absolute/path/to/claudecode-mcp/dist/cli.js"]
    }
  }
}
```

Optional: `npm link` in the clone puts a `claudecode-mcp` command on your
`PATH`. After `git pull`, run `npm ci && npm run build` again.

### HTTP mode (for a server on your tailnet)

`claudecode-mcp --http` serves the same tools over HTTP instead of stdio.
It listens on `127.0.0.1:8787` only, so put
[`tailscale serve`](https://tailscale.com/kb/1312/serve) in front of it to
reach it from other machines. Every request needs a bearer token; make one
per client device:

```sh
claudecode-mcp token add macbook    # prints the token once
claudecode-mcp token list
claudecode-mcp token revoke macbook # takes effect at once
```

(Without `npm link`, run `node dist/cli.js token ...` and
`node dist/cli.js --http` from the clone.)

Add the server's tailnet name to `http.allowed_hosts` (see Configuration).
Full VM setup and client registration are being written up as part of the
network-mode plan (`docs/DESIGN-v2.md` section 12).

## Tools

| Tool | What it does |
|---|---|
| `start_task` | Start Claude Code on a task in `repo` (a local path) or `repo_url` (a git URL; see below). Returns at once with a `task_id`. Default `isolation: "worktree"` (own branch `claude/<slug>-<id>` from `base_ref`, default `HEAD`); `in_place` runs in the folder itself. Options: `profile`, `model`, `effort`, `system_prompt`, `output_schema`, `max_minutes`, `name`. |
| `get_task` | Status, last result, usage, rate-limit summary, recent steps, queue position, and a take-over command. |
| `wait_task` | Wait (up to 50 s per call) until the current turn ends. Call again to keep waiting. |
| `get_events` | Page through the compact transcript with a byte cursor. |
| `send_message` | Message a task. During a turn it joins that turn; `interrupt: true` stops the turn first; an idle task starts a new turn; an exited task is resumed. |
| `get_diff` | Commits, diff stat, new files, and the diff (capped at 200 KiB) since the task's base commit. |
| `cancel_task` | Stop the task. Its session can be resumed later. |
| `close_task` | Finish a task: `keep_branch` (default: remove the worktree folder, keep the branch), `delete`, or `push_pr` (push and open a draft PR with `gh`). Refuses to discard uncommitted work unless `force`. |
| `list_tasks` | Task summaries, newest first, filtered by `status`, `repo`, or `repo_url`. |
| `ask` | Blocking question or review (up to 600 s). Read-only by default (plan mode, file-writing tools blocked). Without `repo` or `repo_url` it runs in an empty temp folder, so put the material in the prompt. With `repo_url` it runs in a temporary checkout of `base_ref` that is removed afterwards. |

A typical flow: `start_task` → `wait_task` (loop) → `get_diff` →
`send_message` to steer → `close_task` with `push_pr`.

### Task states

`queued` → `starting` → `running` ⇄ `idle` → `closing` → `closed`, plus
`stalled` (no events for `stall_minutes`, still alive), `interrupted`
(runner gone, e.g. after a reboot; a message resumes it), `failed`,
`timed_out`, `cancelled`, and `rate_limited`.

### Taking over by hand

`get_task` returns a ready command, for example:

```sh
cd '/repo/.claude/worktrees/t1a2b3c4d5e' && claude --resume 6f1c…
```

Cancel the task first if its runner is still active, so two processes never
drive one session.

### Repos by URL

A server can also take a git URL instead of a local path, so callers on
other machines can hand it work on repos it does not have yet. Turn it on
with an allowlist in the config:

```json
{
  "workspaces_dir": "~/claudecode-workspaces",
  "repo_urls": ["https://github.com/your-name/*", "git@github.com:your-name/*"]
}
```

`start_task` and `ask` then accept `repo_url` (exactly one of `repo` or
`repo_url`). The server keeps one clone per repo at
`<workspaces_dir>/<scheme>_<host>/<owner>/<repo>.git` and fetches it before
each task.
`base_ref` defaults to the remote's default branch; a branch name means the
remote branch. `repo_url` tasks always get a worktree. Accepted URL forms:
`https://host/owner/repo`, `ssh://user@host/owner/repo`, and
`user@host:owner/repo`; `*` in a pattern matches within one path segment.
Results come back through `get_diff` and `close_task` with `push_pr`,
which opens the draft PR against the branch the task started from. When the
server has `GH_TOKEN` in its environment, it uses that token for the push
and the PR; tasks never get it, so Claude itself cannot push.

`claudecode-mcp prune-workspaces [--dry-run] [--force]` removes clones that
no open task uses. It only touches clones it made, and keeps a clone with
unpushed local commits, a stash, or loose files unless `--force`.

## Configuration

Optional file: `~/.config/claudecode-mcp/config.json` (or
`$XDG_CONFIG_HOME/claudecode-mcp/config.json`, or the path in
`CLAUDECODE_MCP_CONFIG`). Without it, the defaults below apply. The file is
strict: unknown keys or bad values stop the server at startup with a clear
error.

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
      "personal_skills": ["commit-style"]
    },
    "reviewer-clean": {
      "permission_mode": "auto",
      "setting_sources": ["project"],
      "skills": false
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `allowed_roots` | your home folder | Repos must be inside one of these (checked by real path). |
| `max_concurrent` | 3 | Turns running at once; more tasks wait as `queued`. |
| `max_minutes` | 120 | Cap per turn. Idle time does not count. |
| `stall_minutes` | 10 | Flag a turn as `stalled` after this long without events. |
| `idle_minutes` | 15 | Keep an idle `claude` alive this long for fast follow-ups. |
| `max_events_mb` | 100 | Cap on a task's transcript; reaching it stops the task. |
| `http.host` | `127.0.0.1` | HTTP mode listen address. Loopback only (`127.0.0.1`, `::1`, `localhost`). |
| `http.port` | 8787 | HTTP mode port. |
| `http.path` | `/mcp` | MCP endpoint path. `GET /healthz` is always there, without auth. |
| `http.allowed_hosts` | `[]` | Extra `Host` names to accept, e.g. `vm.tail1234.ts.net`. Loopback names are always accepted. |
| `http.allowed_origins` | `[]` | Browser origins to accept. Requests with any other `Origin` are refused. |
| `http.tokens_file` | `http-tokens.json` next to config.json | Per-device token hashes (mode 0600). |
| `workspaces_dir` | `~/claudecode-workspaces` | Managed clones for `repo_url` tasks. Must be inside `allowed_roots`. |
| `repo_urls` | `[]` | Allowlist of URL patterns for `repo_url`. Empty turns `repo_url` off. |

### Profiles

A profile decides how the child Claude Code is set up, separate from your
personal setup. The default `worker` profile uses `auto` permission mode, no
MCP servers, and the target repo's own settings, hooks, skills, and
CLAUDE.md.

| Field | Effect |
|---|---|
| `permission_mode` | `auto` (default; needs sonnet or opus, else the task fails at once) or `bypassPermissions`. Always run with `--permission-prompts none`. |
| `setting_sources` | Which settings load: `user`, `project`, `local`. |
| `settings` | A settings file path or an inline settings object. |
| `mcp_servers` | The exact MCP servers for the child. This server is never allowed. |
| `inherit_user_mcp` | Use your own MCP servers too. |
| `disallowed_tools`, `tools` | Block tools, or allow only these built-in tools. |
| `plugin_dirs` | Load these plugin folders. |
| `skills` | `false` turns off all skills. |
| `personal_hooks` | Chosen hooks from your `~/.claude/settings.json`, as `<Event>:<index>`. |
| `personal_skills` | Chosen skills from `~/.claude/skills`, by folder name. |
| `config_dir` | A fully separate Claude home (needs its own login). |
| `model`, `effort`, `env` | Defaults for the child. |

Run `claudecode-mcp list-personal-config` to see your hooks (with indexes)
and skills.

## Safety model

- **Permissions:** `auto` mode lets a safety check decide each action and
  blocks high-risk ones (see `claude auto-mode defaults`). Nothing ever waits
  for a person: anything that would prompt is denied and reported in
  `permission_denials`.
- **Repo URLs:** only URLs matching `repo_urls` are cloned; other schemes
  (`ext::`, `http://`, `git://`, `file://`), credentials in URLs, and
  option-like values are refused, and git may only use https and ssh.
- **Isolation:** worktree tasks never touch your main checkout. Worktrees are
  excluded from your `git status`.
- **No recursion:** the child gets `CLAUDECODE_MCP_DEPTH`; a nested server
  refuses to start tasks, and profiles cannot reset that marker.
- **Environment:** the child gets an explicit allowlist of variables, never
  your whole environment. Host-session variables are never passed.
- **HTTP mode:** loopback only, a per-device bearer token on every request
  (checked in constant time; only hashes are stored), Host and Origin
  checks, and an 8 MiB body cap. Anyone with a token can run Claude Code on
  that machine, so give each device its own token and revoke lost ones.
- **Data:** task state lives in `~/.local/state/claudecode-mcp` (mode 0700).
  Errors sent to clients are redacted.

## State on disk

```
~/.local/state/claudecode-mcp/      ($XDG_STATE_HOME, or CLAUDECODE_MCP_STATE_DIR)
  tasks/<task-id>/task.json          status, session, workspace, result, usage
  tasks/<task-id>/events.jsonl       full stream-json transcript
  tasks/<task-id>/runner.log         the runner's own log
  sessions/<session-id>.lock         one process per session
```

Each task has a detached runner process, so tasks keep running when the MCP
server restarts. A restarted server finds them on disk.

## Environment variables

| Variable | Use |
|---|---|
| `CLAUDECODE_MCP_CONFIG` | Config file path. |
| `CLAUDECODE_MCP_STATE_DIR` | State folder (keep it short: socket paths are limited to 103 bytes). |
| `CLAUDECODE_MCP_CLAUDE_BIN` | Path to the `claude` binary. |
| `CLAUDECODE_MCP_GH_BIN` | Path to the `gh` binary. |
| `CLAUDECODE_MCP_EXTRA_ENV` | Comma-separated extra variables to pass to the child. |
| `CLAUDECODE_MCP_FORWARD_DANGEROUS` | `1` passes request-altering variables such as `ANTHROPIC_CUSTOM_HEADERS`. |
| `CLAUDECODE_MCP_DISPATCH_MS` | Queue dispatcher interval (default 2000). |
| `CLAUDECODE_MCP_ALLOW_FILE_URLS` | `1` allows `file://` repo URLs. For tests only. |
| `CLAUDECODE_MCP_HTTP_GRACE_MS` | HTTP mode: how long SIGTERM waits for in-flight requests (default 10000). |
| `DEBUG=claudecode-mcp` | Structured debug logs on stderr. |

## Troubleshooting

- **`claude CLI ... is too old`**: update Claude Code to 2.1.287 or newer.
- **`claude started in permission mode "default", not "auto"`**: `auto` mode
  needs sonnet or opus. Pick one of those models, or a
  `bypassPermissions` profile.
- **`repo is outside allowed_roots`**: add the folder to `allowed_roots`.
- **`not a git repository`**: pass `isolation: "in_place"`.
- **A task shows `interrupted`**: its runner stopped (reboot, crash). Send it
  a message to resume.
- **Runner problems**: see `tasks/<id>/runner.log` in the state folder.

## Development

```sh
npm install
npm run format:check && npx tsc --noEmit && npm test
npm run test:live    # tiny real prompts; needs a logged-in claude
```

Offline tests use a fake `claude` that emits stream-json. See
[`AGENTS.md`](AGENTS.md) for invariants and conventions, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for pull requests.

## License

MIT
