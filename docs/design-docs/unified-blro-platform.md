# Unified BLRO Platform

**Status:** draft

## Context

Sangfor Engineer MCP currently runs as a JM-local modular monolith. This is the fastest
architecture for stabilizing browser behavior because the browser, authenticated profile,
customer LAN/VPN, operator gate, verifier, evidence, and MCP composition can be exercised in
one workspace without first building a distributed control plane.

The long-term deployment boundary is different:

- **JM is client-side.** It owns the browser process, authenticated profile, customer-network
  reachability, and short-lived execution artifacts.
- **BLRO is server-side.** It will own the integrated MCP, RAG, database, approval, audit,
  evidence, registry, and project/tenant services.

The JM-first implementation must therefore be useful now without making JM a second source of
truth that later has to be reconciled.

## Decision

Complete and operate the browser feature as a JM modular monolith through the pure
`BrowserExecutionPort`. Extract that port across a remote transport only after the local
behavior, security semantics, and operational evidence are stable.

In the unified target, BLRO is the only authority for durable domain state. JM-local browser
profiles are credential containers, not replicated domain records. JM is an enrolled, disposable
execution client. A JM may observe or attempt an approved browser action, but only BLRO evaluates
and persists the authoritative run verdict.

## Runtime boundary

```text
                              authoritative server
┌──────────────────────────────── BLRO ────────────────────────────────┐
│ MCP/API gateway · project modules · tool profiles                    │
│ tenant/project/actor identity · policy · approvals · nonce authority │
│ run state machine · verifier · evidence manifests · audit ledger     │
│ RAG ingest/retrieval · document/chunk provenance · database          │
└───────────────────────┬───────────────────────────────────────────────┘
                        │ future authenticated job/result protocol
                        │ BrowserExecutionPort-compatible JSON payloads
┌───────────────────────▼──────────── JM client ────────────────────────┐
│ browser/profile · LAN/VPN reachability · local Playwright/CDP         │
│ exact-origin session resolution · observation/mutation attempt        │
│ screenshot/temp bytes · bounded disposable cache                      │
└────────────────────────────────────────────────────────────────────────┘
```

The current repository does **not** implement the network link in this diagram. Today the MCP
composition root invokes the local JM port in-process.

## Authoritative data ownership

| Data | Authoritative writer | JM treatment |
|---|---|---|
| Tenant, project, actor, role, membership | BLRO identity/database service | Opaque scoped IDs only |
| Device/console registry and project assignment | BLRO registry | Bounded execution snapshot |
| MCP run, step, status, tool profile | BLRO run service | Active job cache only |
| Approval, action binding, expiry, nonce use | BLRO approval service | Presented capability; never persisted as reusable authority |
| Audit event and hash/HMAC chain | BLRO audit service | Delivery buffer until acknowledged |
| Evidence manifest, hashes, verdict linkage | BLRO evidence service | Temporary bytes and upload receipt |
| RAG document, chunk, embedding, citation | BLRO knowledge service | Optional encrypted transport cache; never answers without a current BLRO authorization decision |
| Browser profile, cookies, authenticated session | JM only | Never uploaded as BLRO domain data |
| Raw screenshot/download bytes | BLRO object store after accepted upload | Delete after acknowledged upload and retention window |
| Final PASS/FAIL/INDETERMINATE | BLRO verifier | JM reports observations and `mutationAttempted`, never final authority |

Each authoritative aggregate has one writer. Replicas, caches, search indexes, and object stores
may be derived, but they cannot accept independent state transitions. There is no conflict merge
between JM and BLRO.

## Required identity and scope

Every durable BLRO record carries:

- `tenantId`
- `projectId`
- `actorId` and actor type
- `runId` and `stepId` where applicable
- source system and creation time
- policy/tool-profile version

Every document, chunk, citation, observation, and evidence manifest additionally carries:

- immutable source/provenance reference
- content hash
- acquisition method and acquisition actor
- trust/classification label
- ACL scope
- parent document/run/evidence lineage

Tenant and project are mandatory security scopes, not optional search filters. A request without
an authorized tenant/project context fails closed.

## ACL and RAG retrieval

RAG retrieval applies scope **before** ranking:

1. Authenticate actor and resolve effective tenant/project memberships.
2. Filter documents/chunks by tenant, project, classification, ACL, and provenance policy.
3. Run lexical/vector candidate retrieval only inside that authorized set.
4. Rerank authorized candidates.
5. Return citations with their immutable provenance.

Post-ranking ACL filtering is forbidden because it can leak scores, identifiers, or content from
another project. Customer-trust material never enters cloud inference without an explicit,
auditable project policy.

## Project modules, not project silos

A project selects versioned modules and tool profiles:

- vendor/product capabilities
- allowed read/write tool classes
- knowledge collections
- evidence and retention policy
- approval policy

BLRO does not deploy a separate MCP, RAG engine, and database for every project. Isolation is
enforced by scoped data and policy in shared server services. Dedicated infrastructure remains an
exception for regulatory or customer-contract requirements, not the default architecture.

## Browser job semantics after extraction

The future transport preserves the current port meanings:

- Requests contain opaque session/profile/auth/artifact references, never cookies, raw
  selectors, JavaScript, CDP endpoints, local paths, approval secrets, or HMAC keys.
- BLRO issues a short-lived, tenant/project/run/action-bound job capability.
- JM validates enrollment, exact origin, expiry, replay state, and allowed high-level operation.
- JM returns observations, evidence hashes/receipts, and whether mutation may have been
  attempted.
- A disconnect after possible mutation is `INDETERMINATE`.
- BLRO performs an independent read-back before PASS.
- Automatic mutation retry and automatic rollback remain forbidden.

Approval authority stays server-side. A remote job capability proves that BLRO authorized one
specific dispatch; it does not turn JM into an approval issuer.

## JM lifecycle and disposal

JM local data is intentionally non-authoritative:

- one enrolled client identity per installation
- project-scoped browser profiles
- bounded job/result delivery buffer
- encrypted cache where platform support exists, keyed to tenant/project/actor scope
- current BLRO authorization required before any cached knowledge is served
- explicit TTL and maximum size
- delete evidence bytes after BLRO acknowledgement
- revoke enrollment and wipe local cache without changing BLRO truth

Browser profiles are a client credential container and need a separate operational backup/login
policy. They are not synchronized through the BLRO database.

## Extraction entry criteria

Do not begin remote extraction until all are true:

1. The JSON `BrowserExecutionPort` contract is versioned and has compatibility fixtures.
2. Local observe/execute/verify/capture paths pass real-browser QA.
3. Mutation attempts cannot become PASS without independent read-back.
4. Origin, locator ambiguity, nonce, evidence, and borrowed-browser invariants are pinned.
5. BLRO tenant/project/actor identity and ACL semantics are approved.
6. BLRO has authoritative registry, knowledge, run, approval, audit, and evidence stores with
   one-writer rules.
7. Enrollment, revocation, delivery acknowledgement, timeout, and duplicate-job behavior are
   designed and threat-modeled.
8. Operations can monitor queue age, disconnected JMs, indeterminate mutations, and evidence
   upload failure.

## Migration sequence

1. Keep JM local-port behavior stable and version its fixtures.
2. Introduce BLRO identity/scope and authoritative stores without changing browser dispatch.
3. Make the in-process port call pass through an internal job envelope and receipt model.
4. Add one authenticated remote transport implementation behind the same contract.
5. Shadow remote dispatch in lab read-only mode and compare observations.
6. Promote reversible lab writes behind existing approval/read-back gates.
7. Migrate project by project; revoke and wipe obsolete JM authoritative-looking state.
8. Remove local server ownership only after BLRO receipts and restore drills pass.

Before each cutover, the migration manifest must name every superseded local authority. The
initial manifest includes the RAG index, device registry, run/change/evidence ledgers, approval
nonce store, PM engagement events, and feedback/eval/wiki records under `data/`. No unlisted
JM-local store may remain an authoritative writer after its BLRO cutover.

## Explicitly deferred

This JM increment does not implement:

- remote JM/BLRO network protocol
- agent enrollment, certificate rotation, or revocation
- signed remote job tickets
- long-poll, WebSocket, queue, retry, or multi-JM routing
- `approval.v2`
- authoritative store migration or data backfill
- Postgres/object-store/vector-store production topology
- active-active BLRO storage
- single-process consolidation of current applications

These require separate designs and migration plans. They must not be smuggled into the local
browser seam as speculative compatibility code.

## Rationale

The local-first sequence minimizes implementation feedback time and lets security behavior be
observed on a real browser before distributed failure modes are added. The pure contract and
runtime import boundary preserve extraction readiness. Server-authoritative ownership prevents
JM cache loss, offline execution, or duplicate delivery from creating competing truth.

## Consequences

- JM remains deployable and testable before BLRO exists.
- A future remote adapter can reuse operation/result semantics, but it is not wire-compatible by
  declaration alone; explicit protocol versioning is still required.
- BLRO must ship identity, scope, ACL, and authoritative storage before remote write execution.
- JM browser profiles and customer-network access remain operational user responsibilities.
- Some local file stores remain authoritative during the transition; each migration needs a
  declared cutover point and rollback based on restored software/data, never automatic device
  rollback.
