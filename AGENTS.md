# sangfor-engineer-mcp

> Sangfor product-specific senior field-engineer MCP monorepo: stdio MCP server, guarded live-execution spine, planner/advisory, local-first RAG + learning, and multi-vendor (Sangfor/FortiOS/Cisco) advisory.

## Architecture
See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the domain map, package layering, dependency-direction rules, runtime topology, and the execution/approval flow.

## Documentation
- [Design Docs](docs/design-docs/index.md) — architectural decisions and core beliefs
- [Plans](docs/plans/) — design references (`designs/`) and execution plans (`work/`); [tech-debt tracker](docs/plans/work/tech-debt-tracker.md)
- [Product Specs](docs/product-specs/index.md) — the field-engineer-replacement product spec
- [Generated](docs/generated/db-schema.md) — Prisma/Postgres schema (optional bridge)
- [References](docs/references/index.md) — external-library reference candidates

## Domain guides
- [Security](docs/SECURITY.md) — **read first before touching any write/execution path**: gates, HMAC approvals, nonces, masking, fail-closed rules
- [Reliability](docs/RELIABILITY.md) — read-back-verified apply, audit ledgers, idempotency, no-auto-rollback
- [Product Sense](docs/PRODUCT-SENSE.md) — the honest replacement-rate model and what stays human
- [Multi-vendor](docs/MULTIVENDOR.md) — how to add a vendor (spec + client + mock + tool)

## Quality & planning
- [Code Review](docs/CODE-REVIEW.md) — review checklist, severity levels, safety-path scrutiny
- [Quality Score](docs/QUALITY-SCORE.md) — per-domain quality grades and gaps
- [Plans process](docs/PLANS.md) — how to write designs and work plans here

## Project structure
- `apps/*` — thin transport adapters, each with a boundary `AGENTS.md`:
  - `apps/mcp-server` — MCP stdio JSON-RPC server (77 `sangfor.*` tools; no port)
  - `apps/http-bridge` — REST façade over the MCP server (`:3600`, fail-closed tool-guard)
  - `apps/control-tower` — ops dashboard, run/approval/registry + playbook engine (`:3700`)
  - `apps/operator-console` — engineer web console, in-process (`:3502`)
  - `apps/mock-sangfor-console` — fake Sangfor/FortiOS/Cisco/OpenStack device (`:3400`)
- `packages/*` — all domain logic (see the catalogue in ARCHITECTURE.md)
- `tests/` — Vitest suites (`tests/**/*.test.ts`, source-only; import package `src/` directly)
- `scripts/` — learning/ingestion/login/crawl pipelines wired to npm scripts
- `data/` — file-based state (curated seeds committed; runtime artifacts gitignored)

## Setup & validation
```bash
corepack enable && pnpm install     # use pnpm; npm ci may break on restricted registries
pnpm test        # vitest run
pnpm run lint    # tsc --noEmit
pnpm run build   # tsc
```
Run an app: `pnpm run dev:mcp | dev:http-bridge | dev:control-tower | dev:web | dev:mock-console`.

## Quick rules (every agent must know)
1. **Read-only by default.** Non-dry-run live writes need `SANGFOR_ALLOW_REAL_EXECUTION` (+ `SANGFOR_ALLOW_PRODUCTION_EXECUTION` in prod) **and** a signed, action-bound, single-use approval. Never weaken a gate to make a test pass — see [SECURITY.md](docs/SECURITY.md).
2. **INDETERMINATE is never PASS**, and a 2xx is never success — only a read-back PASS is. No fabrication: unknown → null/empty/`unsourced`, never a guessed value.
3. **Fail closed.** Missing approval secret, missing service in catalog, corrupt safety/nonce/ledger file, ambiguous UI target, non-loopback bind without token → refuse.
4. **Mask secrets before persistence**; irreversible/customer-facing acts stay human.
5. Dependency imports point **downward only** (see ARCHITECTURE.md layering); `@sangfor/shared` is the leaf.

<!-- MANUAL: Notes below this line are preserved on regeneration -->
