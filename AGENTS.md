# AGENTS.md

Canonical public guide for AI agents and contributors working in this repository.

## Project purpose

`claudecode-mcp` is a stateless stdio MCP server that wraps the headless
`claude` CLI. It exposes one-shot MCP tools for prompts, prompts with local
file context, and schema-constrained structured output.

The server is intentionally narrow: every tool call spawns a fresh `claude`
subprocess, uses the server process's current working directory, and avoids
session tracking or resume behavior.

## Core commands

- `npm install` - install dependencies.
- `npm run build` - compile TypeScript into `dist/` and make `dist/server.js`
  executable.
- `npm test` - run the offline test suite. The `pretest` hook builds first.
- `npm run test:live` - run tests with `CLAUDECODE_MCP_LIVE=1`; requires a
  real authenticated `claude` CLI on `PATH`.
- `npm run format:check` - check Prettier formatting for `src/**/*.ts` and
  `test/**/*.mjs`.
- `npm run format` - format `src/**/*.ts` and `test/**/*.mjs`.

Single tests can be run with Node's test runner after building, for example:

```sh
npm run build
node --test --test-name-pattern='<regex>' test/<file>.test.mjs
```

## CI expectations

GitHub Actions validates pushes and pull requests on Node 20 and 22. The
required CI workflow runs:

- `npm ci`
- `npm run format:check`
- `npx tsc --noEmit -p tsconfig.json`
- `npm run build`
- `npm test`
- `npm audit --omit=dev --audit-level=high` (blocking)
- `npm audit --audit-level=high` (advisory for development-only transitives)

Manual compatibility coverage can be run on demand. Release validation follows
the required checks on Node 20 and 22 and also runs `npm pack --dry-run`.

## Architecture map

- `src/server.ts` - MCP server wiring, tool schemas, request dispatch,
  `baseClaudeArgs()`, and compatibility exports used by tests.
- `src/invoke.ts` - child process spawning, explicit environment allowlist,
  timeout and output caps, JSON parsing, and structured debug logging.
- `src/path-guard.ts` - path containment and file reads for
  `claude_prompt_with_context`.
- `src/validators.ts` - MCP tool input validation and lightweight schema sanity
  checks.
- `src/redaction.ts` - secret redaction, client-safe error formatting, and
  Claude exit error classification.
- `src/flag-probe.ts` - lazy `claude --help` probing for `--json-schema`
  support, with a short per-binary cache.
- `src/env.ts` - shared environment-variable parsing helpers.

Tests live in `test/` and import compiled modules from `dist/`.

## Non-negotiable invariants

- No sessions. Do not add `session_id`, resume support, or session persistence.
  Calls must remain isolated and use `--no-session-persistence`.
- No `working_dir` tool input. Tool calls run under `process.cwd()` of the MCP
  server process.
- Spawn the `claude` CLI with argv arrays only. Do not build shell command
  strings from prompts or user input.
- Prompts above `MAX_PROMPT_ARG_BYTES` (100 KiB) must be delivered to the
  child via stdin, never as a positional argv element: Linux caps a single
  argv string at 128 KiB (`MAX_ARG_STRLEN`), and anything larger fails the
  spawn with `E2BIG`. On Windows, routing must also account for the 32,767
  UTF-16-unit limit on the complete command line. Keep prompt routing
  centralized in `routePromptDelivery()`.
- Keep CLI flag construction centralized in `baseClaudeArgs()`.
- Default mode must not load the user's MCP servers. Non-bare calls must pin
  `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`.
- `--bare` remains opt-in through `CLAUDECODE_MCP_BARE=1`. Bare mode disables
  OAuth/keychain auth, so users need `ANTHROPIC_API_KEY` or an `apiKeyHelper`
  setting.
- The child environment must be an explicit allowlist. Do not pass through the
  full parent environment. Known-dangerous variables stay stripped unless
  `CLAUDECODE_MCP_FORWARD_DANGEROUS=1` is set. Keep `skill.sh` aligned with
  the server allowlist.
- `claude_prompt_with_context` file paths must be relative and contained under
  the server cwd. Absolute paths, `..` escapes, and outbound symlinks are
  rejected. Keep the per-file, file-count, and aggregate-context caps.
- File context blocks use sentinel fences like `----- file: NAME -----`, not
  pseudo-XML wrappers.
- Keep per-call timeout and output caps. When a cap is exceeded, reject with a
  typed error; do not silently truncate output.
- Propagate the MCP request `AbortSignal` to active CLI invocations. On POSIX,
  timeout, cancellation, and output-limit cleanup must terminate the complete
  process group so descendants cannot outlive a tool call.
- Keep every non-prompt argv value explicitly bounded. In particular,
  `system_prompt` and serialized JSON schemas must remain below the per-argument
  operating-system limit, their combined Windows command line must be checked
  before spawn, and schema traversal must stay resource-bounded.
- Errors returned to MCP clients must be redacted and capped. Full diagnostics
  can go to local stderr, but raw subprocess stderr and client-facing messages
  must not expose secrets.
- `claude_prompt` must parse `--output-format json` output. Do not fall back to
  raw stdout when parsing fails.
- `claude_prompt_structured` requires the CLI's `--json-schema` flag and fails
  loudly if unavailable. Do not replace it with prompt-only coercion.
- Structured output comes from the CLI's `structured_output` field. Treat the
  natural-language `result` field as a summary, not the schema-conforming
  value.
- `validateAgainstSchema()` is intentionally lightweight. The CLI's
  `--json-schema` validation remains authoritative.

## Testing guidance

`npm test` is the default verification path for code changes. It builds first
through `pretest`, then runs the offline Node test suite.

If you invoke an individual test file directly, run `npm run build` first
because tests import from `dist/`, not `src/`.

Use `npm run test:live` only when you need end-to-end coverage against a real
`claude` CLI. Live tests require local Claude authentication and are not part
of CI.

Docs-only changes do not require code tests unless they alter command examples,
public behavior, or CI expectations.

## Change hygiene

- Keep pull requests focused on one concern.
- Update tests when behavior changes.
- Update README design notes and this file when an invariant, tool contract,
  command, or operational expectation changes.
- Update `CHANGELOG.md` under `## [Unreleased]` for public-facing changes.
- Do not add runtime dependencies beyond `@modelcontextprotocol/sdk` without
  prior discussion. Justify dev dependency additions.
- Do not add `AGENTS.md` to `package.json` `files` unless the npm package is
  intentionally changed to ship this guide.
