#!/usr/bin/env node
// Fake `claude` CLI for offline tests. Behavior is driven by env vars:
//   CLAUDECODE_MCP_FAKE_VERSION  text printed for --version (default "2.1.288 (Claude Code)")
//   CLAUDECODE_MCP_FAKE_EXIT     exit code for --version (default 0)
//   CLAUDECODE_MCP_FAKE_ENV_OUT  if set, write the received env as JSON to this path
// Later build steps extend this with stream-json output.

import { writeFileSync } from "node:fs";

if (process.env.CLAUDECODE_MCP_FAKE_ENV_OUT) {
  writeFileSync(process.env.CLAUDECODE_MCP_FAKE_ENV_OUT, JSON.stringify(process.env));
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write((process.env.CLAUDECODE_MCP_FAKE_VERSION ?? "2.1.288 (Claude Code)") + "\n");
  process.exit(Number(process.env.CLAUDECODE_MCP_FAKE_EXIT ?? 0));
}
process.stderr.write(`fake claude: unsupported args ${JSON.stringify(args)}\n`);
process.exit(2);
