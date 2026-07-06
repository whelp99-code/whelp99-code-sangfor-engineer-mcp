<!-- Parent: ../../AGENTS.md -->

# mcp-server

> MCP stdio JSON-RPC server exposing the whole Sangfor "senior engineer" toolset (77 `sangfor.*` tools). No HTTP port.

## Constraints
- Entry: `src/index.ts` (single large file). Starts via `startStdioServer()` — hand-rolled JSON-RPC over `readline` on stdin/stdout, **not** the MCP SDK transport. Guarded by `MCP_NO_SERVE`/`VITEST`.
- Tool safety is classified locally: `DESTRUCTIVE_TOOLS` (7) and a larger `WRITE_TOOLS` set; everything else read-only. **Keep these classifications correct** — the http-bridge and control-tower trust the annotations derived here.
- Adding a tool: register it in the `tools` registry with accurate annotations (`readOnlyHint`/`destructiveHint`), and route any write/execute through the package's gated path — never inline a device mutation here.
- This app is a thin adapter: put logic in a package, expose it as a tool.

## Working here
- Widest fan-in in the repo (~27 packages). Import by relative path (`../../../packages/<pkg>/src/index.js`).
- Smoke: `printf '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | pnpm run dev:mcp`; `pnpm run smoke:mcp`; `pnpm run check:mcp-scorecard`.
- Tests: `tests/hci-mcp-tools.test.ts` and the safety-gate suites.

## Dependencies
- Depends on: nearly all `packages/*` (planner, knowledge, operator, approval, rag, wiki, evidence, feedback, hci-client, vendor clients/specs, …).
- Depended on by: `apps/http-bridge` (spawns it as a child over stdio).

<!-- MANUAL: Notes below this line are preserved on regeneration -->
