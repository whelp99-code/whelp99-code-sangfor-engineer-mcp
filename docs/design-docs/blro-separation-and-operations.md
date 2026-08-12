# BLRO Separation, Operation, and JM Endpoint Installation — Work Plan

**Status:** Active
**Related:** [Unified BLRO Platform](unified-blro-platform.md) ·
[BLRO Authority Architecture](../BLRO_AUTHORITY_ARCHITECTURE.md) ·
[JM Endpoint Install](../JM_ENDPOINT_INSTALL.md) ·
[BLRO Operations Runbook](../BLRO_OPERATIONS_RUNBOOK.md)

## Goal

Take the completed JM-first modular monolith and separate it into the two deployment roles it was
designed for, without weakening any gate:

- **JM** — the client-side browser execution edge, installed on engineer endpoints.
- **BLRO** — the server-side authority for MCP, RAG, database, approvals, audit, evidence.

Done looks like: BLRO runs as an operated server with authoritative stores and a documented
runbook; JM installs on an endpoint from a scripted, fail-closed procedure; and every mutation
still requires a signed action-bound approval, a single-use nonce consumed last, an exact origin,
and an independent read-back before PASS.

## Current position

Shipped and verified in commits `caef744` and `fbd01f5`:

- `BrowserExecutionPort` is a pure JSON seam; no Playwright/CDP/page/cookie/path crosses it.
- `@sangfor/jm-execution` is the only local browser implementation.
- Operator/verifier/screenshot/observer/MCP consume the port and contain no browser runtime edge.
- `pnpm run check:browser-boundary` prints `BLRO_READY_BROWSER_BOUNDARY_PASS`.
- Real-Chromium QA passed: observe, dry-run, approved reversible mutation, independent read-back,
  evidence capture, restore, plus bad-origin and forbidden-operation refusals.

Shipped in this increment:

- `scripts/lib/jm-endpoint-preflight.mjs` + `scripts/jm-endpoint-preflight.mjs` — fail-closed
  endpoint readiness with machine-readable reason codes.
- `scripts/lib/jm-endpoint-install.mjs` + `scripts/jm-endpoint-install.mjs` — ordered install plan,
  `--doctor` diagnosis, `--run` safe execution.
- `pnpm run jm:endpoint:preflight | jm:endpoint:doctor | jm:endpoint:install`.

What does **not** exist yet, and is therefore what this plan sequences: the remote JM↔BLRO
protocol, enrollment/revocation, server-side authoritative stores, and BLRO operations.

## Non-negotiable invariants across every phase

1. Approval authority is server-side. A remote job capability proves BLRO authorized **one**
   dispatch; it never turns JM into an approval issuer.
2. The nonce is consumed after all preflight refusals and immediately before mutation — moving it
   earlier or later is a defect, not an optimization.
3. Only an independent read-back `PASS` is success. A click, an HTTP 2xx, or a dispatched job is
   `INDETERMINATE`.
4. A disconnect after possible mutation is `INDETERMINATE`. No automatic retry, no automatic
   rollback.
5. Cookies, `storageState`, authorization headers, CDP endpoints, local paths, approval secrets,
   and HMAC keys never cross the contract in either direction.
6. Tenant and project are mandatory security scopes, not search filters. A request without an
   authorized scope fails closed.
7. One writer per authoritative aggregate. JM caches are derived and disposable.

## Phase 1 — Endpoint installability (DONE in this increment)

**Outcome:** any supported host can be turned into a JM edge and can prove its own readiness.

- [x] Fail-closed preflight with explicit reason codes (`BROWSER_EXECUTABLE_UNSET`,
      `BROWSER_EXECUTABLE_MISSING`, `CDP_PROFILE_REGISTRY_CORRUPT`, `CDP_BIND_NOT_LOOPBACK`,
      `CDP_PROFILE_ORIGIN_INVALID`, `CDP_PROFILE_PORT_INVALID`, `APPROVAL_SECRET_MISSING`,
      `PRODUCTION_OPT_IN_REQUIRED`, `NODE_VERSION_UNSUPPORTED`).
- [x] Install planner whose safe path needs no customer credentials or network, plans no device
      mutation, and plans no execution-gate opt-in.
- [x] Registered scripts and an endpoint install guide bound to the real script names.
- Test: `pnpm exec vitest run --config vitest.config.ts tests/jm-endpoint-preflight.test.ts
  tests/jm-endpoint-install.test.ts`.

## Phase 2 — Job envelope inside the monolith

**Outcome:** the in-process call already looks like a remote job, so extraction changes transport
only.

- [ ] Introduce `JobEnvelope { jobId, tenantId, projectId, runId, stepId, issuedAt, expiresAt,
      capability, request }` and `JobReceipt { jobId, acceptedAt, status, observations,
      mutationAttempted, evidenceRefs }` in `@sangfor/browser-contracts` — test: envelope/receipt
      round-trip plus rejection of a request carrying a forbidden key.
- [ ] Route the MCP composition root through envelope→port→receipt with no behavior change —
      test: existing operator/verifier/screenshot suites stay green unchanged.
- [ ] Version the contract (`browser-execution-request.v1`) with compatibility fixtures — test: a
      v1 fixture parses and an unknown version refuses.

## Phase 3 — BLRO authoritative stores

**Outcome:** BLRO owns durable truth; JM owns nothing durable.

- [ ] Identity/scope service: tenant, project, actor, role, membership — test: a request without an
      authorized tenant/project fails closed.
- [ ] Move each store behind a single writer: device registry, run/step state, approval + nonce,
      audit chain, evidence manifests, RAG documents/chunks. Each cutover names the superseded
      JM-local store from the migration manifest in the unified-BLRO design.
- [ ] Scope-before-rank retrieval for RAG — test: a chunk outside the actor's project never enters
      the candidate set, asserted before ranking, not after.
- [ ] Append-only audit with hash/HMAC chaining — test: tamper detection on a rewritten entry.

## Phase 4 — Enrollment and the remote transport

**Outcome:** one authenticated JM↔BLRO link behind the unchanged contract.

- [ ] Enrollment: one client identity per installation, certificate issuance, rotation, revocation
      — test: a revoked identity is refused before any job is issued.
- [ ] Short-lived job capability bound to tenant/project/run/action — test: replay, expiry, wrong
      origin, and wrong action each refuse.
- [ ] Transport adapter implementing `BrowserExecutionPort` — test: the existing port suites run
      unchanged against the remote adapter.
- [ ] Timeout/disconnect/duplicate-delivery semantics — test: a disconnect after dispatch yields
      `INDETERMINATE`, never `PASS` and never an automatic retry.

## Phase 5 — Shadow, promote, migrate

**Outcome:** production cutover without a trust gap.

- [ ] Shadow remote dispatch in lab read-only mode; compare observations against local dispatch.
- [ ] Promote reversible lab writes behind the existing approval/read-back gates.
- [ ] Migrate project by project; revoke and wipe superseded JM-local authoritative state.
- [ ] Remove local server ownership only after BLRO receipts and a restore drill pass.

## Phase 6 — Operations

**Outcome:** the platform is operable by someone who did not build it.

- [ ] Runbook coverage for deploy, upgrade, backup/restore, revocation, incident, and monitoring —
      the shipped [BLRO Operations Runbook](../BLRO_OPERATIONS_RUNBOOK.md) is its first
      version and each phase above updates it.
- [ ] Alerting on queue age, disconnected JMs, indeterminate mutations, evidence-upload failure,
      approval-secret access, and audit-chain verification failure.
- [ ] Quarterly restore drill from backup into a scratch environment with a recorded receipt.

## Entry criteria before Phase 4 starts

All must hold, from the unified-BLRO design:

1. Versioned contract with compatibility fixtures.
2. Local observe/execute/verify/capture pass real-browser QA.
3. Mutation cannot become PASS without independent read-back.
4. Origin, locator ambiguity, nonce, evidence, and borrowed-browser invariants pinned by tests.
5. Tenant/project/actor identity and ACL semantics approved.
6. BLRO authoritative stores exist with one-writer rules.
7. Enrollment, revocation, acknowledgement, timeout, and duplicate-job behavior threat-modeled.
8. Operations can monitor queue age, disconnected JMs, indeterminate mutations, upload failure.

Items 1-4 are satisfied today. Items 5-8 are Phase 3/4/6 work.

## Rollback

Rollback means restoring the previous software artifact and halting for human review. The system
never auto-mutates a device to undo an uncertain change. Any action lacking independent read-back
stays `INDETERMINATE` and is escalated, not retried.

## Verification

Commands run for the Phase 1 increment. Observed results were captured to the author's local
evidence directory (`.omo/` is gitignored and not part of the repository); re-run these to
reproduce them:

```bash
pnpm exec vitest run --config vitest.config.ts tests/jm-endpoint-preflight.test.ts tests/jm-endpoint-install.test.ts
node scripts/jm-endpoint-preflight.mjs --json
pnpm run jm:endpoint:doctor
pnpm test
pnpm run lint
pnpm run build
pnpm run check:browser-boundary
pnpm run smoke:mcp
```

## Decision log

- 2026-08-12: Endpoint installability sequenced **before** the remote protocol. An endpoint that
  cannot prove its own readiness cannot be trusted to hold a remote job capability, and the
  preflight reason codes become the enrollment health signal in Phase 4.
- 2026-08-12: The installer plans but never enables an execution gate. Enabling real or production
  execution stays a deliberate per-window human action, so an install script can never widen the
  blast radius of a routine setup.
