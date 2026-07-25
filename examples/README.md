# Examples

Each `*.json` file in this directory is a single JSON-RPC 2.0 `tools/call`
request that the running MCP server will accept on stdin.

The MCP server speaks newline-delimited JSON-RPC over stdio (each line is a
complete JSON object). To send one of these requests by hand, you must include
an `initialize` request first. The simplest way to drive these examples is
from an MCP-aware client such as Claude Code or any MCP debug client.

A minimal manual smoke (newline-delimited; not strict MCP framing) for local
spelunking only:

```sh
npm run build
( cat <<'EOF'
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0.0.0"}}}
EOF
  cat examples/claude_prompt.json
) | node dist/server.js
```

Files:

- `claude_prompt.json` — minimal one-shot text prompt.
- `claude_prompt_with_context.json` — prompt with free-form context and a
  file path. File paths must be relative and resolve under the server's cwd.
- `claude_prompt_structured.json` — schema-constrained JSON via the CLI's
  `--json-schema` flag. Requires a `claude` CLI build that supports it.
