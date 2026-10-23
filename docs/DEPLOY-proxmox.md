# Deploy claudecode-mcp on a Proxmox VM

Run the HTTP server on a dedicated VM and reach it over the tailnet. The VM
is the sandbox: tasks run there, on clones that live there, with credentials
that live there. A local stdio install on a dev machine is unchanged.

```
dev machine (MCP client) ──HTTPS (tailnet)──▶ tailscale serve on the VM
                                                │ http://127.0.0.1:8787/mcp
                                                ▼
                                   claudecode-mcp --http (systemd)
                                                │
                                                ▼
                                     runners ─▶ claude -p ─▶ worktrees
```

The server listens on `127.0.0.1` only. `tailscale serve` publishes it as
HTTPS on `https://<vm>.<tailnet>.ts.net`. Clients also send a bearer token.
Design and threat model: [`DESIGN-v2.md`](DESIGN-v2.md) section 12.

Checked against current Tailscale source and `systemd.kill(5)` on
2026-10-23. This repo's CI does not boot Proxmox or join a tailnet, so the
Host-header curl and the runner-restart check below are the on-VM
confirmation.

## 1. Virtual machine

| | |
|---|---|
| vCPU | 2–4 |
| RAM | 8 GB (the default `max_concurrent` is 3; lower it if the VM swaps) |
| Disk | 40 GB. Clones and worktrees live under the `claude` home. |
| OS | Debian 13 or Ubuntu 24.04 LTS |

Give the VM a NIC that can reach the internet (Tailscale, GitHub, Anthropic).
Do not add a Proxmox port forward or DNAT rule to it. Nothing on the VM
should be reachable except through Tailscale.

The QEMU guest agent lets Proxmox shut the VM down cleanly. Optional:

```sh
sudo apt-get install -y qemu-guest-agent
```

## 2. User and packages

Tasks and the server run as one Unix user, `claude`. That user is not an
admin. SSH in as an admin, then:

```sh
sudo adduser --disabled-password --gecos "" claude
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo apt-get install -y gh
```

If `gh` is not a package on that image, install it from
[cli/cli's Linux instructions](https://github.com/cli/cli/blob/trunk/docs/install_linux.md).
`close_task` with `push_pr` needs `gh` on the service `PATH`.

### Node.js 22

The server requires Node 22 or newer. Distro packages are often older.
NodeSource's Node 22 repo uses a distro-independent suite:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
node -v   # v22.x
```

The unit's `ExecStart` is `/usr/bin/node`, which is where this package lands.
If the script refuses the release, install the official 22.x tarball instead
and point `ExecStart` at `command -v node` (usually `/usr/local/bin/node`):

```sh
arch=$(dpkg --print-architecture)
case "$arch" in amd64) na=x64 ;; arm64) na=arm64 ;; *) echo "unsupported: $arch"; exit 1 ;; esac
curl -fsSL -o /tmp/SHASUMS256.txt https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
ver=$(awk -v a="$na" '$2 ~ "linux-" a ".tar.xz$" { print $2; exit }' /tmp/SHASUMS256.txt)
curl -fsSL -o "/tmp/$ver" "https://nodejs.org/dist/latest-v22.x/$ver"
awk -v f="$ver" '$2 == f { printf "%s  /tmp/%s\n", $1, $2 }' /tmp/SHASUMS256.txt | sha256sum -c -
sudo tar -xJf "/tmp/$ver" -C /usr/local --strip-components=1
node -v
```

## 3. Claude Code

Install as `claude`, so the binary lands in `/home/claude/.local/bin/claude`
(the native installer's launcher; the unit's `PATH` and
`CLAUDECODE_MCP_CLAUDE_BIN` point there). Version **2.1.287 or newer**.

```sh
sudo -u claude -H bash -lc 'curl -fsSL https://claude.ai/install.sh | bash'
sudo -u claude -H test -x /home/claude/.local/bin/claude
sudo -u claude -H /home/claude/.local/bin/claude --version
```

Log in one of two ways.

**Token (fits a headless VM).** On a machine with a browser, run
`claude setup-token` (Pro, Max, Team, or Enterprise). It prints a one-year
token and does not store it. Put that token in `service.env` as
`CLAUDE_CODE_OAUTH_TOKEN` (step 7). The child environment allowlist forwards
that variable to `claude`. Leave `ANTHROPIC_API_KEY` unset unless you mean
to bill the API: when it is set, `claude -p` uses the key instead of the
subscription token.

**Browser login over SSH.** `ssh -t` as `claude` and run `claude auth login`.
Credentials land in `/home/claude/.claude`. Skip `CLAUDE_CODE_OAUTH_TOKEN`
in that case: when the variable is set, it takes precedence over the stored
login.

The check that the login works is in step 7, once `service.env` exists.
`/healthz` can be green before that. The first task runs `claude --version`
(2.1.287 or newer) and then `claude` itself.

## 4. Install claudecode-mcp

```sh
sudo -u claude -H git clone https://github.com/trevoraspencer/claudecode-mcp.git /home/claude/claudecode-mcp
sudo -u claude -H bash -lc 'cd ~/claudecode-mcp && npm ci && npm run build'
```

## 5. Config

```sh
sudo -u claude -H bash -c 'umask 077; mkdir -p ~/.config/claudecode-mcp ~/claudecode-workspaces'
```

Write `/home/claude/.config/claudecode-mcp/config.json` as `claude`, mode
`0600`. Unknown keys or a bad value stop the process at startup.

```json
{
  "allowed_roots": ["/home/claude/claudecode-workspaces"],
  "workspaces_dir": "/home/claude/claudecode-workspaces",
  "repo_urls": ["https://github.com/OWNER/*"],
  "http": {
    "allowed_hosts": ["vm.tailnet.ts.net"]
  }
}
```

- `allowed_roots` is only the workspaces directory. The default is the whole
  home, and a caller who can pass `repo` could then point a task at the
  checkout or `~/.config`. On this VM, work comes in as `repo_url`.
- `repo_urls` is an allowlist. No match, no clone. Use `https` URLs. The
  server's `GH_TOKEN` authenticates https clone, fetch, and push. An
  `ssh://` or `git@github.com:` pattern needs a key, and push to that
  origin does not use `GH_TOKEN`.
- `http.allowed_hosts` is the MagicDNS hostname only: no scheme, port, or
  path. `tailscale serve` forwards that name as the `Host` header (see
  step 9). Loopback names are always accepted. Leave `http.host` unset so
  it stays `127.0.0.1`. The config accepts only loopback there
  (`127.0.0.1`, `::1`, `localhost`). Leave `http.allowed_origins` empty: a
  request that sends an `Origin` header is refused, and MCP clients do not
  send one.
- A runner socket under the default state directory is 70 bytes
  (`/home/claude/.local/state/claudecode-mcp/tasks/t0000000000/runner.sock`),
  under the 103-byte limit. Set `CLAUDECODE_MCP_STATE_DIR` only if you move
  state onto a longer path.
- Config is read at startup. A change needs `sudo systemctl restart claudecode-mcp`.

Replace `OWNER` and `vm.tailnet.ts.net`. The real hostname is printed by
`tailscale serve status` in step 9; you can write the file now and fill the
host after `tailscale up`, then restart.

## 6. A token per client device

`--http` refuses to start with no tokens. Hashes only, mode `0600`, in
`http-tokens.json` next to the config. The plaintext is printed once.

```sh
sudo -u claude -H /usr/bin/node /home/claude/claudecode-mcp/dist/cli.js token add laptop
```

Device names match `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`. Copy the `ccm_…` value
to that device, then clear it from the VM's shell history. The running
server re-reads the file on every request. Revoke later with the same
command, `token revoke laptop`, in place of `token add`. Use `-H` on both:
without it the file can land in `/root/.config`.

## 7. GitHub token, env file, default-branch ruleset

Push and draft PRs use a fine-grained personal access token in the
service environment. Tasks do not get `GH_TOKEN`. A task runs as `claude`,
so it can still read `/proc/<server-pid>/environ` and this file. Treat that
as a soft boundary: scope the token, and protect the default branch.

Create the token (GitHub → Settings → Developer settings → Fine-grained
tokens):

- Only the repositories named by `repo_urls`.
- Contents: Read and write. Pull requests: Read and write. Metadata: Read.
- An expiration date. Renew by editing `service.env` and restarting.
- Add the `workflows` permission only if a task must push under
  `.github/workflows/`.

Write `/home/claude/.config/claudecode-mcp/service.env` as `claude`, mode
`0600`. systemd ignores blank lines and lines starting with `#`. No quotes,
no `export`.

```
CLAUDE_CODE_OAUTH_TOKEN=paste-setup-token
GH_TOKEN=paste-fine-grained-pat
```

Leave `CLAUDE_CODE_OAUTH_TOKEN` out when you used `claude auth login`.
Leave `gh` logged out. Clone, fetch, push, and `gh pr create` read
`GH_TOKEN` from the environment; a second `gh auth login` is a different
credential store.

```sh
sudo -u claude -H bash -c 'set -a; . ~/.config/claudecode-mcp/service.env; set +a
  /home/claude/.local/bin/claude auth status
  timeout 90 /home/claude/.local/bin/claude -p "reply with the single word ok"
  gh api user --jq .login'
```

`claude auth status` prints `"loggedIn": true`, the prompt answers, and
`gh` prints the GitHub login that owns the token. If the prompt sits at a
trust question, run it once under `ssh -t` as `claude` and answer it.
The variables disappear when that shell exits.

On each allowlisted repo, add a ruleset targeting the default branch:
require a pull request before merging, block force pushes, restrict
deletions. Do not add the token's user as a bypass actor. Task branches
are `claude/<slug>-<id>`, and `push_pr` opens the draft PR against the
branch the task started from.

A ruleset cannot limit one token of a user without limiting that user's
other pushes. Branch-limiting the VM to `claude/**` takes a second GitHub
account for the token, a ruleset on every other branch (restrict
creations, updates, and deletions; block force pushes) that excludes
`claude/**`, and a bypass for your day-to-day account. The default-branch
ruleset above is the one to add either way.

## 8. systemd

```sh
sudo cp /home/claude/claudecode-mcp/examples/claudecode-mcp.service /etc/systemd/system/claudecode-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now claudecode-mcp
sudo systemctl status claudecode-mcp
```

The unit is `User=claude`, `Restart=on-failure`, `KillMode=process`.
Runners are detached with a new session, and that does not leave the
service cgroup. `KillMode=control-group` (the default) would kill them on
`systemctl restart`, so a running task would not survive an upgrade.
`process` signals only the main PID. `TimeoutStopSec=20` is longer than
the HTTP grace period (10s), so the process can finish in-flight requests
and exit before systemd sends SIGKILL.

`Restart=on-failure` starts the process again after a crash. A clean
`systemctl stop` stays stopped. Upgrades use `systemctl restart`.

A reboot still ends runners. The next start marks those tasks
`interrupted`; `send_message` resumes them from the state directory.

Logs are the process's stderr, as JSON lines:

```sh
journalctl -u claudecode-mcp -f
```

A task's own transcript is `tasks/<id>/runner.log` under the state
directory. The journal is the server process. Startup fails closed when
the config is invalid, the tokens file is missing or unsafe, or there are
no tokens. A good start logs `"phase":"http_listening"` with
`"host":"127.0.0.1"` and `"port":8787`.

```sh
curl -fsS http://127.0.0.1:8787/healthz
```

`GET /healthz` has no auth and does not check `Host`. It only proves the
process is up.

After a task is `running`, confirm a restart leaves its runner. `get_task`
reports `runner_alive`, not the pid; the pid is `runner.pid` in `task.json`:

```sh
TASK=t…   # id from start_task
STATE=/home/claude/.local/state/claudecode-mcp/tasks/$TASK/task.json
PID=$(sudo -u claude -H node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!s.runner) process.exit(1); console.log(s.runner.pid)' "$STATE")
ps -p "$PID" -o pid,cmd
sudo systemctl restart claudecode-mcp
ps -p "$PID" -o pid,cmd
sudo systemctl show -p MainPID claudecode-mcp
```

The runner pid is still alive, and `MainPID` is a new node process.
`get_task` still shows the task `running`. Leave `MemoryMax` and
`TasksMax` off this unit: both apply to the whole cgroup, runners
included.

## 9. Tailscale

```sh
curl -fsSL https://tailscale.com/install.sh | sh
```

In the tailnet policy, let yourself own the tag, then join the VM with it
(step 10 has the ACL). Tag ownership has to exist before `--advertise-tags`
will stick:

```sh
sudo tailscale up --advertise-tags=tag:claudecode
```

Approve the tag in the admin console if the device stays untagged.
Enable HTTPS certificates for the tailnet (the admin console, or the page
`tailscale serve` opens the first time). Then proxy the loopback server
with Serve, which stays on the tailnet. Leave Funnel off: Funnel publishes
the same port on the public internet.

```sh
sudo tailscale serve --bg --yes http://127.0.0.1:8787
sudo tailscale serve status
```

`status` prints `https://<vm>.<tailnet>.ts.net` and
`proxy http://127.0.0.1:8787`. `--bg` keeps that across reboot and
`tailscale down` / `tailscale up`. Turn it off with `sudo tailscale serve off`.

Current Tailscale (CLI 1.52 and later) takes this form. If `--bg` is
absent from `tailscale serve --help`, upgrade Tailscale; the install
script above gets a current client.

For a TCP backend, Serve sets the request's `Host` to the incoming host,
which is the MagicDNS name, and sets `X-Forwarded-Host` to the same value.
That name goes in `http.allowed_hosts`. Put it there and restart:

```sh
sudo systemctl restart claudecode-mcp
```

From the VM, this must print `200`. A name missing from `allowed_hosts` is
`403` with `host not allowed`. A bad token is `401`. `TOKEN` is the
`ccm_…` value from step 6.

```sh
TOKEN=ccm_…
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Host: vm.tailnet.ts.net" \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:8787/mcp
unset TOKEN
```

From another machine on the tailnet, `GET /healthz` needs no token, and
`tools/list` needs the device token:

```sh
curl -fsS https://vm.tailnet.ts.net/healthz
curl -fsS https://vm.tailnet.ts.net/mcp \
  -H "Authorization: Bearer $(cat token)" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A 200 body is JSON or a short SSE stream with the tool list. Registering
that URL on each dev machine (`claude mcp add`, next to a local stdio
server) is the client writeup, design step N5.

## 10. Firewall and tailnet ACL

Anyone who can open the endpoint with a token can run Claude on the VM in
`auto` mode. Two controls: no inbound path except Tailscale, and an ACL
that names who may use it.

Keep the current tailnet policy and add a tag plus a rule. Replacing a
default allow-all policy with only this rule drops every other device's
access, including your SSH.

```json
{
  "tagOwners": {
    "tag:claudecode": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["YOUR_TAILNET_IDENTITY"],
      "dst": ["tag:claudecode:443,22"]
    }
  ]
}
```

`443` is Serve. `22` is SSH over the tailnet, so you can still administer
the VM. Identity headers (`Tailscale-User-Login`) are not checked; the
bearer token and this ACL are the gate.

On the VM, after a second session over the tailnet IP or MagicDNS name is
open (so this cannot cut the session you are typing in):

```sh
sudo apt-get install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on tailscale0
sudo ufw enable
```

That drops new connections on the non-Tailscale NIC. The ACL is what
limits which tailnet devices can connect. The Proxmox firewall, if you
use it, should allow the VM's outbound traffic and add no inbound DNAT.

## 11. Upgrades

```sh
sudo -u claude -H bash -lc 'cd ~/claudecode-mcp && git pull && npm ci && npm run build'
sudo cp /home/claude/claudecode-mcp/examples/claudecode-mcp.service /etc/systemd/system/claudecode-mcp.service
sudo systemctl daemon-reload
sudo systemctl restart claudecode-mcp
```

Copy the unit again when the example changes. A restart keeps running
tasks (step 8). Follow `main`, or check out a commit and skip `git pull`
the next time, if you want to pin one.

## 12. What to back up

The disk holds the subscription login and the GitHub token. Back it up
somewhere that stays private.

| Path | Why |
|---|---|
| `/home/claude/.config/claudecode-mcp/config.json` | Allowlist, roots, `allowed_hosts`. |
| `/home/claude/.config/claudecode-mcp/http-tokens.json` | Device-token hashes. Losing it means issuing new device tokens. The plaintext lives only on the devices. |
| `/home/claude/.config/claudecode-mcp/service.env` | `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN`. |
| `/home/claude/.local/state/claudecode-mcp/` | Task state and transcripts. Required to resume a task. |
| `/home/claude/.claude/` | Stored `claude auth login`, and the sessions `--resume` needs. |
| `/home/claude/claudecode-workspaces/` | Unpushed commits. Clones can be fetched again; unpushed work cannot. |

```sh
sudo -u claude -H /usr/bin/node /home/claude/claudecode-mcp/dist/cli.js prune-workspaces --dry-run
```

`--dry-run` prints what it would delete. Drop that flag to remove managed
clones that no open task uses. A clone with unpushed commits, a stash, or
loose files is kept unless you pass `--force`.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `Failed to load environment files` | `service.env` exists, is mode `0600`, and its path matches the unit. |
| exit at startup, `invalid claudecode-mcp config` | The journal line names the key. Config is strict. |
| `no tokens` / tokens file `too open` | `token add` as `claude` with `-H`. File mode `0600`, not a symlink, directory not group-writable. |
| `403 host not allowed` | `http.allowed_hosts` is the MagicDNS hostname from `tailscale serve status`, then restart. |
| `403 origin not allowed` | The client sent an `Origin` header. Add that exact origin to `http.allowed_origins`, or use a client that omits it. |
| `401` | `Authorization: Bearer ccm_…` for a name still in `token list`. |
| `claude CLI not found` or `too old` | `/home/claude/.local/bin/claude` exists, is 2.1.287+, and matches `CLAUDECODE_MCP_CLAUDE_BIN`. |
| tasks show `interrupted` after a reboot | Expected. `send_message` resumes. After `systemctl restart` only, the runner should still be alive (step 8). |
| push or PR fails | `gh api user` works with `service.env`. `repo_urls` is `https`. The default branch is protected, and the task branch is `claude/…`. |
