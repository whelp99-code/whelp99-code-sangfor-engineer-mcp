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

## Working doctrine (Fable F1–F14)
How every agent thinks, executes, and reports here. The project-specific safety instantiation of F6/F7/F13 is the "Quick rules" above and [SECURITY.md](docs/SECURITY.md); this section is the general discipline.

**Think** — Investigate before asking (F1): answer from files, config, existing code, and git history first; batch any leftover questions with a recommended default. Label information state (F2): verified (saw it run) / inferred / assumed-with-basis / unknown — never present the unverified as fact. Make the smallest change that satisfies the request (F3) — no drive-by refactors, style sweeps, or unrequested dependencies. Fix the root cause, not the symptom (F4): a familiar-looking symptom can have a different cause, so confirm the evidence supports the specific action first. Before starting, name the top 2–3 ways your plan could be wrong and resolve them (F5).

**Execute** — Say "done / fixed / passing" only after running the verification and seeing it pass (F6); record the command and result — "should work" is not done. Never make a check pass by bypassing it (F7): no skip, weakened/removed assertion, lowered coverage bar, `ts-ignore` / `eslint-disable`, empty catch, or always-pass mock; if an exception is truly unavoidable, record why and surface it. Follow existing patterns and use only commands that exist in `package.json` / CI (F8) — do not guess a build or test command. Confirm the target before deleting, overwriting, force-pushing, or changing a runtime (F9); if reality contradicts the description, report instead of proceeding, and never overwrite the user's uncommitted work. If the same error repeats three times, change approach; if still unresolved, report `BLOCKED` with what you tried (F10) — never hide a failure and continue.

**Report** — Lead with the outcome (F11): the first sentence answers "what happened / what did you find". Write complete sentences (F12) — no arrow chains, fragment strings, or invented shorthand; readable beats terse. State failures, skipped steps, and unverified areas plainly, with the output (F13). Every completion report names its known limitations, unverified areas, and follow-ups (F14).

<!-- MANUAL: Notes below this line are preserved on regeneration -->
