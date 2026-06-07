# Agent instructions

## Project overview

Sangfor product-specific senior engineer MCP monorepo: stdio MCP server, planner/approval/operator packages, RAG, wiki, feedback, and fine-tune pipelines.

## Setup

```bash
corepack enable
pnpm install
```

Use **pnpm** (`packageManager` in `package.json`). `npm ci` may fail on restricted registries and leave broken empty `node_modules/@types/*` folders.

## Validation

```bash
pnpm test
pnpm run lint
pnpm run build
```

Optional smoke tests:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}' | pnpm run dev:mcp
pnpm run dev:mock-console   # http://localhost:3400
```

## Live execution gates

Non-dry-run console actions require `SANGFOR_ALLOW_REAL_EXECUTION` and approval payload. Production also requires `SANGFOR_ALLOW_PRODUCTION_EXECUTION`.

## Layout

- `apps/mcp-server` — MCP stdio JSON-RPC server
- `apps/mock-sangfor-console` — mock HCI console (port 3400)
- `apps/operator-console` — 웹 UI + REST API (port 3500, `pnpm run dev:web`)
- `packages/*` — domain logic
- `tests/` — Vitest suites (source only; `dist/` excluded)
