# claudecode-mcp

[![CI](https://github.com/trevoraspencer/claudecode-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/trevoraspencer/claudecode-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/claudecode-mcp.svg)](https://www.npmjs.com/package/claudecode-mcp)

Local stdio MCP server that wraps the headless Claude Code CLI as MCP tools.
Stateless, spawn-per-call.

## Tools

- `claude_prompt { prompt, model?, system_prompt? }`
- `claude_prompt_with_context { prompt, context?, files?, model?, system_prompt? }`
- `claude_prompt_structured { prompt, schema, model?, system_prompt? }` —
  uses `claude --json-schema`; fails loudly if the installed CLI lacks that flag.

## Install from npm

```sh
npm install -g claudecode-mcp
```

Or install locally and reference the binary from `node_modules/.bin/`. The
package exposes a `claudecode-mcp` executable that runs the stdio server.

You also need the [`claude` CLI](https://docs.claude.com/en/docs/claude-code)
on your `PATH`, authenticated however you normally use it (OAuth, keychain,
or `ANTHROPIC_API_KEY`). This server inherits that auth — it does not manage
credentials of its own.

**Recommended `claude` CLI version: 2.1.0 or later.** `claude_prompt_structured`
needs the `--json-schema` flag, and `--no-session-persistence` had a brief
regression in v2.0.57 (see [anthropics/claude-code#20398](https://github.com/anthropics/claude-code/issues/20398))
that's resolved in current 2.1.x builds.

## Build from source

```
npm install
npm run build
node dist/server.js
```

## Register

Claude Code (`~/.claude/mcp.json`):
```json
{
  "mcpServers": {
    "claudecode": {
      "command": "claudecode-mcp"
    }
  }
}
```

If you installed locally instead of globally, point `command` at `node` and
`args` at the absolute path to `dist/server.js`:

```json
{
  "mcpServers": {
    "claudecode": {
      "command": "node",
      "args": ["/absolute/path/to/claudecode-mcp/dist/server.js"]
    }
  }
}
```

## Examples

The `examples/` directory ships with the npm tarball. Each `*.json` is a
single JSON-RPC `tools/call` request for one of the three tools. See
[`examples/README.md`](./examples/README.md) for a one-liner to drive them
against `node dist/server.js`.

## skill.sh

`skill.sh` is a minimal shell wrapper for direct CLI invocation outside MCP.
Usage: `./skill.sh "<prompt>" [working_dir]`. It runs `claude --print` with
the same flags the MCP server uses. Not installed with the npm package.

## Debug logging

Set `DEBUG=claudecode-mcp` to get one structured JSON line per spawn / call
on stderr. No prompt bodies are logged — only tool names, byte counts, exit
codes, and durations.

```sh
DEBUG=claudecode-mcp claudecode-mcp
```

## Test live

```
npm run test:live
```
Runs tiny real prompts against `claude`. Skipped unless `CLAUDECODE_MCP_LIVE=1`.

## Troubleshooting

**`claude: command not found` (or `spawn claude ENOENT`).**
The MCP server invokes `claude` from your shell `PATH`. If your `claude` CLI
lives outside `PATH` (or you're launching the MCP under a process that has a
different `PATH`, e.g. some IDEs), set `CLAUDECODE_MCP_CLAUDE_BIN` to the
absolute path of the binary:

```sh
export CLAUDECODE_MCP_CLAUDE_BIN=/usr/local/bin/claude
```

Verify the binary works on its own first:
```sh
"$CLAUDECODE_MCP_CLAUDE_BIN" --version
```

**Auth not configured / `Please run claude login`.**
This server runs `claude` as a child process and inherits its auth. If
`claude --print "hi"` fails on your shell, the MCP will fail too. Fix the CLI
first:

- For OAuth/keychain auth: run `claude login` once interactively.
- For API-key auth: `export ANTHROPIC_API_KEY=sk-ant-...` in the environment
  that launches the MCP server (your shell, your IDE, your launchd plist,
  etc.).

`--bare` is intentionally not used — it would disable OAuth/keychain and
force `ANTHROPIC_API_KEY`. That's a deliberate design decision, not a bug.

**`claude_prompt_structured` errors with "does not support the --json-schema flag".**
Your installed `claude` CLI predates `--json-schema`. Upgrade Claude Code
(`npm i -g @anthropic-ai/claude-code` or whatever your install method is) or
fall back to `claude_prompt`.

## Design notes

- No session tracking. No `session_id` in tool inputs. `--no-session-persistence` always.
- No `working_dir` parameter. Uses `process.cwd()` of the MCP server process.
- Argv array spawning — never shell-interpolated. Prompts larger than 100 KiB
  are delivered to the CLI via stdin instead of a positional argument (in
  `--print` mode the CLI reads the prompt from stdin when no positional is
  given). This stays under the OS per-argument size limit (Linux
  `MAX_ARG_STRLEN`, 128 KiB), so large contexts — up to the 5 MB per-file
  cap — spawn successfully instead of failing with `E2BIG`.
- `--bare` is opt-in via `CLAUDECODE_MCP_BARE=1`. Default keeps OAuth/keychain
  auth working, but pins `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`
  so the wrapped subprocess does NOT load the user's own MCP servers (avoids
  the recursion footgun where this server is itself in `~/.claude/mcp.json`).
  In bare mode, OAuth/keychain are unavailable; you must set
  `ANTHROPIC_API_KEY` or pass `apiKeyHelper` via `--settings`.
  See https://code.claude.com/docs/en/headless#start-faster-with-bare-mode.

### Subprocess timeout and output cap

- Default 10-minute per-call timeout. Override with `CLAUDECODE_MCP_TIMEOUT_MS=<ms>`.
  On timeout the subprocess is sent `SIGTERM` and then `SIGKILL` after a 2s
  grace, and the tool call rejects with an `InvokeTimeoutError`.
- Default 50 MB cap on combined stdout/stderr from a single call. Override with
  `CLAUDECODE_MCP_MAX_OUTPUT_BYTES=<bytes>`. On overflow the subprocess is
  killed and the call rejects with `OutputTooLargeError`. There is no silent
  truncation — truncated JSON would parse to wrong data.

### File context safety (`claude_prompt_with_context`)

- File paths must be **relative** to the server process's working directory.
  Absolute paths, `..` escapes, and symlinks pointing outside cwd are rejected.
- Per-file size cap, default 5 MB. Override with `CLAUDECODE_MCP_MAX_FILE_BYTES=<bytes>`.
- File contents and paths are inserted into the prompt inside `----- file: NAME -----`
  fenced blocks (not pseudo-XML), so quotes or angle brackets in paths cannot
  break the block boundaries.

### Subprocess environment

The child inherits an explicit **allowlist** of environment variables, not the
full parent env. Pass-through includes:

- Shell/locale: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TZ`,
  `TMPDIR`, `LANG`, `LC_*`, `XDG_*`.
- Anthropic auth: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`,
  `CLAUDE_CODE_OAUTH_SCOPES`.
- Cloud provider auth: `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_AWS_*`,
  `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_VERTEX_PROJECT_ID`.
- Routing: `ANTHROPIC_BASE_URL`, `ANTHROPIC_*_BASE_URL`.
- Model selection: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_BETAS`.
- TLS: `CLAUDE_CODE_CERT_STORE`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`,
  `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`.
- Locations: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DEBUG_LOGS_DIR`.
- Anything in `CLAUDECODE_MCP_EXTRA_ENV` (comma-separated key names).

Always force-set: `NO_COLOR=1`, `TERM=dumb`. Always **stripped** (unless
`CLAUDECODE_MCP_FORWARD_DANGEROUS=1`): `CLAUDE_CODE_SHELL_PREFIX`,
`CLAUDE_CODE_EXTRA_BODY`, `ANTHROPIC_CUSTOM_HEADERS`,
`CLAUDE_CODE_SCRIPT_CAPS`, `CLAUDECODE`.

### Error messages

Errors returned to MCP clients are truncated (1 KB) and redact `sk-ant-*`
tokens, `Bearer …` headers, and any verbatim copies of values held in known
auth env vars. The full untruncated stderr is logged to the MCP server's local
stderr for debugging.

## License

[MIT](./LICENSE) © 2026 Trevor Spencer
