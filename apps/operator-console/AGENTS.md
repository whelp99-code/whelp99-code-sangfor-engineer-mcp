<!-- Parent: ../../AGENTS.md -->

# operator-console

> Engineer web console (`:3502`): project analysis, config-plan generation, RAG search, knowledge browsing, feedback. Calls packages **in-process** (no MCP hop).

## Constraints
- Entry: `src/server.ts` (port 3502, `PORT`/`OPERATOR_CONSOLE_PORT`, `assertBindSafety`). Handlers in `src/api.ts`, UI in `src/ui.ts`. (Note: legacy docs say `:3500` — the code is `:3502`.)
- Unlike control-tower/bridge, this app imports domain packages **directly** and runs them in-process — so it must respect the same gates the packages enforce; it does not get to bypass them.
- Surface: UI at `/`; read `GET /api/summary|products|knowledge|coverage|spec-coverage|diagnoses|health/store|health/embeddings`; write `POST /api/analyze-project|generate-config-plan|rag-search|discover-console|analyze-requirements|import-excel|feedback`.

## Working here
- Keep it a thin adapter over packages; no device mutation logic here.
- Run: `pnpm run dev:web` (alias of `dev:operator-console`).
- Tests: `tests/operator-console-auth.test.ts`.

## Dependencies
- Depends on: `@sangfor/{shared,collector,competency,feedback,knowledge,planner,product-adapters,rag,safety,spec,store,wiki}`.
- Depended on by: none (top-level app).

<!-- MANUAL: Notes below this line are preserved on regeneration -->
