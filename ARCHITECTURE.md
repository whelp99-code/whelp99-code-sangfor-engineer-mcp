# Architecture

> Sangfor "senior field engineer" MCP monorepo: an AI that advises, plans, and (behind hard gates) executes Sangfor/FortiOS/Cisco device work — read-only by default, irreversible acts always human-signed.

pnpm workspace (`apps/*` + `packages/*`), run directly from TypeScript source via `tsx` (no build artifacts needed to run). Principle: **thin apps, fat packages** — apps are transport adapters; all domain logic lives in `packages/*`, rooted at the leaf `@sangfor/shared`.

## Domain map

- **Advisory & planning** — turn a project/requirement into a cited, risk-classified config plan; evaluate intended-vs-observed device state into PASS / FAIL / **INDETERMINATE** advisories.
- **Guarded execution** — the safety spine: risk classification, HMAC action-bound approvals, single-use nonces, read-back-verified apply, hash-chained audit ledgers. See [SECURITY.md](docs/SECURITY.md).
- **Knowledge & learning** — local-first RAG over Sangfor manuals/KB/community, plus a feedback → lesson → wiki → evals → fine-tune loop.
- **Multi-vendor** — Sangfor (live REST + browser/CDP), FortiOS (REST), Cisco IOS-XE (RESTCONF/YANG) unified by one spec/evaluate engine.
- **Orchestration & ops** — device registry, run ledger, approval queue, and a playbook execution engine (Control Tower).

## Runtime topology

```
Cursor / MCP client ──stdio JSON-RPC──► apps/mcp-server        (77 sangfor.* tools; no port)
AIOSv2 portal ──HTTP──► apps/http-bridge (:3600) ──spawns──► apps/mcp-server (stdio)
apps/control-tower (:3700) ──HTTP──► http-bridge (:3600), mock-console (:3400)
apps/operator-console (:3502) ──in-process──► packages/* (no MCP hop)
apps/mock-sangfor-console (:3400)  = fake Sangfor/FortiOS/Cisco/OpenStack device
```

Apps import packages by **relative path** (`../../../packages/<pkg>/src/index.js`); packages import each other via the `@sangfor/*` / `@sangfor-engineer/*` tsconfig aliases.

## Dependency layering (the rule: imports point downward, never up)

```
L3 orchestration : verifier, product-adapters, screenshot, pptx  ── apps
L2 execution     : operator (→approval,chrome), planner (→approval,knowledge,rag,wiki)
L1 domain/data   : approval · safety · runs · evidence · config-state · hci-client · spec
                   version · sizing · rca · pm · store · integration · knowledge · rag
                   feedback · finetune · evals · wiki · competency · collector · chrome
L0 foundation    : @sangfor/shared   (leaf — no internal deps; everything imports it)
```

Enforced invariants of the graph: no L1 package imports an L2/L3 package; `operator` is pulled in only by `product-adapters`; `planner` only by `verifier`; `collector` receives `rag`/`finetune` by **dependency injection** (function params), not import. `shared` is the only universal dependency.

## Package catalogue

| Package | Layer | Owns |
|---|---|---|
| `@sangfor/shared` | L0 | domain types, product catalog, `resolveRepoData`/`nowId`, HTTP-bind safety (`assertBindSafety`, `checkAuth`) |
| `@sangfor/approval` | L1 | keyword risk classifier → is-approval-required (the risk brain) |
| `@sangfor/safety` | L1 | data-driven capability safety/maturity oracle; fail-safe deny |
| `@sangfor/runs` | L1 | append-only JSONL run ledger + secret masking |
| `@sangfor/evidence` | L1 | ConfigPlan → Markdown/JSON evidence report |
| `@sangfor/config-state` | L1 | captured XHR pools → provenance-carrying observed facts |
| `@sangfor/hci-client` | L1 | HCI/SCP OpenStack client: Keystone auth, apply state machine, read-back, audit ledger |
| `@sangfor/spec` | L1 | vendor-agnostic intended-vs-observed evaluate engine (PASS/FAIL/INDETERMINATE) |
| `@sangfor/version` `/sizing` `/rca` | L1 | sourced version-compat / sizing-tier / root-cause advisories (null when unsourced) |
| `@sangfor/pm` | L1 | engagements, hash-chained PM events, cross-engagement device locks |
| `@sangfor/store` | L1 | optional Prisma/Postgres persistence (no-op unless `DATABASE_URL`) |
| `@sangfor/integration` | L1 | static cited LDAP/RADIUS/SIEM recipes (human executes) |
| `@sangfor/knowledge` | L1 | in-memory seed manuals + keyword search |
| `@sangfor/rag` | L1 | ingest→chunk→embed→local vector index + semantic search/rerank |
| `@sangfor/feedback` `/evals` `/finetune` | L1 | feedback→lesson, planner safety-text evals, JSONL fine-tune datasets/jobs |
| `@sangfor/wiki` | L1 | review-gated proposal→approve→apply to Obsidian/GitHub-wiki adapters |
| `@sangfor/competency` | L1 | WorkAtom taxonomy + honest "1인 대체율" replacement-rate metric |
| `@sangfor/collector` | L1 | scrape Sangfor KB/community → normalized docs → learn pipeline |
| `@sangfor/chrome` | L1 | Chrome CDP + Playwright driver for ExtJS consoles, CAPTCHA OCR |
| `@sangfor/operator` | L2 | mock/live console execution + the signed-approval write gate |
| `@sangfor/planner` | L2 | ProjectInput → cited, risk-classified ConfigPlan |
| `@sangfor/verifier` | L3 | run a plan's validationPlan read-only (never mutates) |
| `@sangfor/product-adapters` | L3 | per-product Excel→plan→dry-run→gated-apply→verify |
| `@sangfor/screenshot` `/pptx` | L3 | per-menu console capture; setting/ops `.pptx` guides |
| `@sangfor-engineer/{fortios,cisco}-spec` | L1 | declarative read-only baselines (IntendedSpec) |
| `@sangfor-engineer/{fortios,cisco}-client` | L1 | vendor API JSON → normalized config-state (mapper-only) |

## Multi-vendor abstraction

Not an OO device interface — a **data contract + shared engine**. Each vendor ships a **spec** package (`IntendedSpec`, keyed by `observedKey` = *what to observe*) and a **client** package (pure functions: vendor API JSON → observed values). `@sangfor/spec.evaluateSpec(spec, observed)` is vendor-agnostic. Adding a vendor = spec + client + mock handler + MCP tool + spec data files, with **no engine change**. Transports differ: HCI = live REST (OpenStack/Keystone, the only mutation path), FortiOS = REST, Cisco = RESTCONF/YANG (both mapper-only), IAG/EPP/CC = browser/CDP. See [docs/MULTIVENDOR.md](docs/MULTIVENDOR.md).

## Execution & approval flow (the safety spine)

1. Every action defaults to **dry-run**; a non-dry-run live write must clear, in order: `SANGFOR_ALLOW_REAL_EXECUTION=true` → (production) `SANGFOR_ALLOW_PRODUCTION_EXECUTION=true` → a valid **HMAC action-bound approval** (`SANGFOR_OPERATOR_APPROVAL_SECRET` signs `approvedBy·changeTicketId·rollbackPlanId·nonce·expiresAt·action.type·action.target`) → **single-use nonce** consumed durably → origin-lock. Any missing piece **fails closed**. Central gate: `assertRealExecutionAllowed()` in `@sangfor/operator`.
2. Control Tower playbooks pause at a write block, mint a bridge approval on human approve, and resume (`continueFromApprove`). The HTTP bridge (`tool-guard.ts`) independently refuses destructive tools always and write tools on non-loopback binds without `SANGFOR_ALLOW_REMOTE_WRITE`.
3. Apply never trusts a 2xx — only a **PASS read-back** is success; INDETERMINATE ≠ PASS; failure **halts for a human** (no auto-rollback). Every step lands in a hash-chained audit ledger.

## Data flow (learning pipeline)

`collector` scrapes Sangfor KB + community → `data/sources/raw/*.md` + `manifest.json` → `rag.ingestDocument` chunks+embeds into the **local JSON vector index `data/rag/index.json`** → `ragSearch` cosine-ranks (+optional rerank) → runtime feedback → `feedback` lessons → `wiki` proposals (`pending_review`, token-gated) → `evals` safety-text checks → `finetune` JSONL datasets (`data/finetune/`) + job specs. Embeddings are local by default (`rapid-mlx` MLX server), with a deterministic `hash` fallback so ingest/search always work offline; cloud is gated by `SANGFOR_ALLOW_CLOUD_RAG`.

## Persistence

Primary state is **file-based** (see `data/`): RAG index, run ledgers (`data/runs/*.jsonl`), registry (`vendors.json` seed + gitignored `devices.json`), evidence/change-run ledgers, nonce store (`data/runtime/`). Postgres via Prisma (`@sangfor/store`) is an **optional bridge**, only active with `DATABASE_URL` + `SANGFOR_DB_ENABLED!=0`. Feedback/lessons/wiki proposals/eval cases are **in-memory only** (lost on restart — see [tech-debt-tracker](docs/plans/work/tech-debt-tracker.md)). Curated seeds under `data/` are committed; runtime artifacts are gitignored.
