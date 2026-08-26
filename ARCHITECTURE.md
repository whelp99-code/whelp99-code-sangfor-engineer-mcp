# Architecture

> Sangfor "senior field engineer" MCP monorepo: an AI that advises, plans, and (behind hard gates) executes Sangfor/FortiOS/Cisco device work — read-only by default, irreversible acts always human-signed.

pnpm workspace (`apps/*` + `packages/*`), run directly from TypeScript source via `tsx` (no build artifacts needed to run). Principle: **thin apps, fat packages** — apps are transport adapters; all domain logic lives in `packages/*`, rooted at the L0 leaves `@sangfor/shared` and `@sangfor/browser-contracts`.

## Domain map

- **Advisory & planning** — turn a project/requirement into a cited, risk-classified config plan; evaluate intended-vs-observed device state into PASS / FAIL / **INDETERMINATE** advisories.
- **Guarded execution** — the safety spine: risk classification, HMAC action-bound approvals, single-use nonces, read-back-verified apply, hash-chained audit ledgers. See [SECURITY.md](docs/SECURITY.md).
- **Knowledge & learning** — local-first RAG over Sangfor manuals/KB/community, plus a feedback → lesson → wiki → evals → fine-tune loop.
- **Multi-vendor** — Sangfor (live REST + browser/CDP), FortiOS (REST), Cisco IOS-XE (RESTCONF/YANG) unified by one spec/evaluate engine.
- **Orchestration & ops** — device registry, run ledger, approval queue, and a playbook execution engine (Control Tower).

## Runtime topology

```
Cursor / MCP client ──stdio JSON-RPC──► apps/mcp-server        (108 sangfor.* tools; no port)
                                          │ pure JSON BrowserExecutionPort
                                          ▼
                                      JM local runtime ──► Playwright / loopback CDP
AIOSv2 portal ──HTTP──► apps/http-bridge (:3600) ──spawns──► apps/mcp-server (stdio)
Remote MCP client ──HTTP POST /mcp──► apps/http-bridge (:3600) (stateless, Bearer-gated; see docs/adapters/remote-http.md)
apps/control-tower (:3700) ──HTTP──► http-bridge (:3600), mock-console (:3400)
apps/operator-console (:3502) ──in-process──► packages/* (no MCP hop)
apps/mock-sangfor-console (:3400)  = fake Sangfor/FortiOS/Cisco/OpenStack device
```

Apps import packages by **relative path** (`../../../packages/<pkg>/src/index.js`); packages import each other via the `@sangfor/*` / `@sangfor-engineer/*` tsconfig aliases.

## Dependency layering (the rule: imports point downward, never up)

```
L3 orchestration : verifier, product-adapters, screenshot, pptx  ── apps
L2 execution     : operator (→approval,browser-contracts), planner (→approval,knowledge,rag,wiki)
JM runtime edge  : jm-execution (→observer,browser-contracts; only maintained Playwright/CDP behavior)
L1 domain/data   : approval · safety · runs · evidence · config-state · hci-client · spec
                   version · sizing · rca · pm · store · integration · knowledge · rag
                   feedback · finetune · evals · wiki · competency · collector · observer
L0 foundation    : @sangfor/shared · @sangfor/browser-contracts
```

Enforced invariants of the graph: no L1 package imports an L2/L3 package; `operator` is pulled in only by `product-adapters`; `planner` only by `verifier`; `collector` receives `rag`/`finetune` by **dependency injection** (function params), not import. `shared` is the only universal dependency.

## Package catalogue

| Package | Layer | Owns |
|---|---|---|
| `@sangfor/shared` | L0 | domain types, product catalog, `resolveRepoData`/`nowId`, HTTP-bind safety (`assertBindSafety`, `checkAuth`) |
| `@sangfor/browser-contracts` | L0 | strict JSON-serializable `BrowserExecutionPort` request/result schemas; no browser runtime or credentials |
| `@sangfor/identity` | L0 | fail-closed tenant/project/actor/role/membership authorization read model |
| `@sangfor/authority` | L1 | sole Postgres writer for BLRO enrollment, at-most-once remote-job tombstones/results, registry, run/step, approval, audit, evidence, and RAG aggregates |
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
| `@sangfor/observer` | L1 | fail-closed, read-only structural observation policy with injected transport |
| `@sangfor/jm-execution` | JM runtime edge | local session resolution, Playwright/CDP execution, screenshots, and observer transport behind `BrowserExecutionPort` |
| `@sangfor/chrome` | legacy | retained compatibility helpers; not part of the maintained MCP/operator/verifier/evidence browser path |
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

1. Every action defaults to **dry-run**. A non-dry-run live write requires the execution flags, a valid complete-action-bound HMAC approval, origin/request validation, an authoritative read-only preflight, and a durable single-use nonce consumed immediately before mutation dispatch. `SANGFOR_OPERATOR_APPROVAL_SECRET` signs `approvedBy·changeTicketId·rollbackPlanId·nonce·expiresAt·canonicalActionJson`; the canonical JSON includes all supplied action fields, including browser `value`, `menuPath`, and `formFields`. Any missing piece **fails closed**. Central gate: `assertRealExecutionAllowed()` in `@sangfor/operator`.
2. Control Tower playbooks pause at a write block, mint a bridge approval on human approve, and resume (`continueFromApprove`). The HTTP bridge (`tool-guard.ts`) refuses destructive tools without a valid single-use approval and refuses write tools on non-loopback binds without `SANGFOR_ALLOW_REMOTE_WRITE`.
3. Apply never trusts a 2xx — only a **PASS read-back** is success; INDETERMINATE ≠ PASS; failure **halts for a human** (no auto-rollback). Every step lands in a hash-chained audit ledger.

## Data flow (learning pipeline)

`collector` scrapes Sangfor KB + community → `data/sources/raw/*.md` + `manifest.json` → `rag.ingestDocument` chunks+embeds into the **local JSON vector index `data/rag/index.json`** → `ragSearch` cosine-ranks (+optional rerank) → runtime feedback → `feedback` lessons → `wiki` proposals (`pending_review`, token-gated) → `evals` safety-text checks → `finetune` JSONL datasets (`data/finetune/`) + job specs. Embeddings are local by default (`rapid-mlx` MLX server), with a deterministic `hash` fallback so ingest/search always work offline; cloud is gated by `SANGFOR_ALLOW_CLOUD_RAG`.

## Persistence

In JM-local compatibility mode, primary state is **file-based** (see `data/`): RAG index, run ledgers (`data/runs/*.jsonl`), registry (`vendors.json` seed + gitignored `devices.json`), evidence/change-run ledgers, nonce store (`data/runtime/`). In BLRO cutover mode (`SANGFOR_BLRO_AUTHORITY_STORE=postgres`), those aggregate writers refuse and `BlroAuthorityStore` is the sole Postgres writer; approval nonces remain exclusively owned by `PostgresSingleUseNonceStore`. The superseded paths are enumerated in `docs/design-docs/blro-authority-migration-manifest.json`. Postgres via Prisma (`@sangfor/store`) is an **optional bridge**, only active with `DATABASE_URL` + `SANGFOR_DB_ENABLED!=0`. Feedback/lessons/wiki proposals/eval cases are **persisted as file-based JSONL** (`@sangfor/shared` `appendJsonl`/`foldJsonlById`, roots configurable via `SANGFOR_FEEDBACK_ROOT`/`SANGFOR_EVALS_ROOT`/`SANGFOR_WIKI_ROOT`) — survives restart. Control-tower paused-block `originalArgs` remain intentionally in-memory only. Curated seeds under `data/` are committed; runtime artifacts are gitignored. Multi-customer deployments can set `SANGFOR_ENGAGEMENT_ID` to isolate the run ledger, search-gap feedback file, and saved session reports under an extra `<engagementId>` path segment (`@sangfor/shared` `resolveEngagementScopedData`); unset, these roots are unchanged from single-tenant behavior. All JSON-file stores (RAG index, control-tower registry/playbooks, HCI audit ledger) now write via `@sangfor/shared`'s `writeFileAtomicSync`/`withDirLock` (wx-temp + fsync + directory-mutex, generalized from `sangfor-learning-strategy`'s store) and `ragSearch` ranks a hybrid of BM25 keyword score and cosine similarity with an mtime-invalidated index cache, rather than a pure O(n) cosine scan. SQLite/vector-DB migration for the RAG index remains deliberately deferred — this stays a dependency-free `npx`-installable server, and ANN indexing is still open (tech-debt #5).
