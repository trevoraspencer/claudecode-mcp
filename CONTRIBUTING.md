# Contributing to claudecode-mcp

Thanks for your interest. This project is small and intentionally narrow in
scope — a stateless stdio MCP wrapper around the `claude` CLI. Please read
the [Design notes](./README.md#design-notes) before proposing changes. Some
boundaries (no session tracking, no `working_dir` arg) are deliberate, and PRs
that revisit them should explain why.

## Build

```sh
npm install
npm run build
```

Output lands in `dist/`. The compiled `dist/server.js` is the binary referenced
by the `bin` field of `package.json`.

## Test

Tests are written with Node's built-in `node:test` runner — no external test
framework is used or accepted.

```sh
npm run build  # tests import from dist/, so build first
npm test       # offline unit tests only
```

To exercise a real `claude` CLI end-to-end:

```sh
npm run test:live
```

Live tests are gated on `CLAUDECODE_MCP_LIVE=1` and require an authenticated
`claude` CLI on `PATH`. They are not run in CI.

To run a single test by name:

```sh
node --test --test-name-pattern='<regex>' test/<file>.test.mjs
```

## Pull requests

- Open an issue first for anything beyond a small bug fix or doc tweak — it's
  cheaper to align on direction than to redo a PR.
- Keep changes focused. One concern per PR.
- Run `npm run build && npm test` locally before pushing; required CI runs the
  same commands on Node 22 and 24.
- Update `CHANGELOG.md` under an `## [Unreleased]` heading.
- Do not add runtime dependencies beyond `@modelcontextprotocol/sdk` and `zod` without
  prior discussion. Devtime additions should be justified.
- Preserve the design invariants in `AGENTS.md` and `docs/DESIGN-v2.md`.

## Reporting issues

Use [GitHub Issues](https://github.com/trevoraspencer/claudecode-mcp/issues).
Include:

- `node --version`
- `claude --version`
- The exact MCP request that triggered the failure (or a minimal reproduction).
- Whether your `claude` CLI is authenticated via OAuth/keychain or
  `ANTHROPIC_API_KEY`.
