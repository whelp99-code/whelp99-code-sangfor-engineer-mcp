<!-- Parent: ../../AGENTS.md -->

# control-tower

> Ops dashboard + orchestration API (`:3700`): device registry, run/approval tracking, vendor sweeps, and a **playbook execution engine**.

## Constraints
- Entry: `src/server.ts` (thin router + shared-secret gate on `/api/*` via `checkAuth`, `assertBindSafety` fail-closed). All logic is in `createApi(opts)` in `src/api.ts`; `ApiError(status, message)` carries HTTP status.
- Talks to `http-bridge` (`:3600`, `CONTROL_TOWER_BRIDGE_URL`) and `mock-console` (`:3400`) **over HTTP**, not by import (`src/bridge-client.ts`).
- File-backed stores under `resolveRepoData`: `RunStore` → `data/runs/*.jsonl`; `Registry` → `data/registry/{vendors.json(seed),devices.json(gitignored)}`; `PlaybookStore` → `data/registry/playbooks.json`; `AgentTaskStore` → `data/registry/agent-tasks.json`; reports → `outputs/playbooks/<id>.md`.

## Working here — playbook engine (the tricky part)
- A playbook = ordered blocks (`tool` + `report`), stored as versioned revisions; only an **approved active revision** executes.
- Read-only tool block runs immediately; a write/destructive block creates a `pending_approval` run, **stashes un-masked original args in an in-memory map**, and pauses. Run status is **derived, not stored** (`derivePlaybookRunStatus`).
- `POST /api/runs/:id/approve` recovers the stashed args (400 if lost to a restart — prevents sending masked `***` to a device), mints a bridge approval, and resumes via `continueFromApprove`. Keep this fail-safe.
- Sweeps are read-only-only (non-read-only tool in a sweep is force-failed); concurrency 3.
- `renderReport` tabulates FAIL **and** INDETERMINATE. Never drop INDETERMINATE — a run with `ok=false, fail=0` would otherwise render as clean.
- Seeds (`src/playbook-seed.ts`): `planSeedPlaybooks` derives candidates from `vendors.json` `advisorTools` (no product hard-coding), keyed by `seedKey` for idempotency. `POST /api/playbooks/seed`, the UI button, and startup (`seedOnStart`, off with `SANGFOR_TOWER_SEED_PLAYBOOKS=0`) all go through `api.seedPlaybooks()`. Seeded rev 1 stays `draft` — seeding must never bypass the review gate.
- Tests: `tests/control-tower-playbook-{api,engine,store,seed}.test.ts`, `control-tower-approval-mint.test.ts`, `control-tower-e2e.test.ts`.

## Playbooks over MCP
- `apps/mcp-server` exposes 9 `sangfor.playbook_*` tools that **proxy this REST API** (`src/tower-client.ts`, `SANGFOR_TOWER_URL`). The tower stays the single writer of `playbooks.json` — never write that file from another process.
- Revision approve/reject is deliberately **not** on the MCP surface: approval is a human action in this UI.
- `validateBlocks` rejects `sangfor.playbook_*` as a block `toolId` (nested playbook execution is out of scope).

## Dependencies
- Depends on: `@sangfor/shared`, `@sangfor/runs`, `@sangfor/operator` (approval types), `@sangfor/collector` (load-env); http-bridge + mock-console over HTTP.
- Depended on by: none (top-level app).

<!-- MANUAL: Notes below this line are preserved on regeneration -->
