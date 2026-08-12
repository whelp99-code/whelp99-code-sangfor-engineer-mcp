# BLRO Operations Runbook

How to operate **BLRO**, the server-side authority for MCP, RAG, database, approvals, audit, and
evidence.

**Status:** first version. BLRO's remote transport, enrollment, and authoritative stores are
sequenced in [the separation plan](design-docs/blro-separation-and-operations.md); this
runbook covers what is operable today and states plainly what is not yet implemented. Nothing here
describes a running production system unless it names the shipped command that produces it.

Boundary reminder: JM is the client-side browser execution edge
([install guide](JM_ENDPOINT_INSTALL.md)). BLRO never holds browser profiles, customer cookies, or
customer credentials. See [BLRO Authority Architecture](BLRO_AUTHORITY_ARCHITECTURE.md) and
[Unified BLRO Platform](design-docs/unified-blro-platform.md).

## 1. What BLRO owns

| Aggregate | Single writer | Loss impact |
|---|---|---|
| Tenant / project / actor / membership | identity service | total: every scope check fails closed |
| Device & console registry | registry service | execution targets unresolvable |
| Run / step / status | run service | in-flight work becomes indeterminate |
| Approval, action binding, nonce use | approval service | **no mutation may proceed** |
| Audit event + hash chain | audit service | compliance gap; chain must be reverifiable |
| Evidence manifest, hashes, verdicts | evidence service | customer deliverables unprovable |
| RAG documents, chunks, embeddings, citations | knowledge service | advisory quality degrades |

One writer per aggregate. Replicas, caches, and search indexes are derived and may be rebuilt; they
never accept an independent state transition. There is no conflict merge between JM and BLRO.

## 2. Services in the repository today

These run in-process and are operable now:

| Service | Command | Port |
|---|---|---|
| MCP stdio server | `pnpm run dev:mcp` | none (stdio) |
| HTTP bridge (REST façade) | `pnpm run dev:http-bridge` | 3600 |
| Control tower (runs, approvals, registry, playbooks) | `pnpm run dev:control-tower` | 3700 |
| Operator console | `pnpm run dev:web` | 3502 |
| Mock device console (lab only) | `pnpm run dev:mock-console` | 3400 |

Bind policy is fail-closed: any non-loopback bind requires `SANGFOR_API_TOKEN`. A missing token on
a non-loopback bind is refused at startup, not warned about.

## 3. Deploy and upgrade

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run lint
pnpm run build
pnpm test
pnpm run smoke:mcp              # expect: smoke-mcp-tools: ok (108 tools)
pnpm run check:browser-boundary # expect: BLRO_READY_BROWSER_BOUNDARY_PASS
pnpm run check:mcp-scorecard
```

Promote only when all are green. Upgrade order matters: **BLRO first, JM endpoints second.** A JM
endpoint may run one contract minor version behind; a BLRO behind its endpoints can be asked for a
capability it does not understand, and must refuse rather than improvise.

Rollback is restoring the previous artifact plus its schema-compatible data, then halting for human
review. Never auto-mutate a device to undo a change.

## 4. Secrets

| Secret | Purpose | Rotation |
|---|---|---|
| `SANGFOR_OPERATOR_APPROVAL_SECRET` | HMAC key for action-bound approvals | rotate on suspicion, on operator departure, and quarterly |
| `SANGFOR_API_TOKEN` | bearer token for any non-loopback bind | rotate with each network exposure change |
| `SANGFOR_CHANGE_LEDGER_SECRET` | change-ledger chain integrity | rotate with the ledger cutover only |
| `SANGFOR_WIKI_APPROVAL_SECRET` | wiki proposal approvals | quarterly |

Rules: secrets are injected from the platform secret manager at process start, never committed,
never logged, never echoed into evidence. A missing approval secret with real execution enabled is
a **refusal**, not a warning — the endpoint preflight reports `APPROVAL_SECRET_MISSING` and JM will
not dispatch.

Rotation drains cleanly because approvals are short-lived: stop issuing with the old key, wait for
outstanding approvals to expire, then swap. Never accept two keys indefinitely.

## 5. Backup and restore

Back up, in this order of criticality: approval/nonce state, audit chain, evidence manifests, run
state, registry, RAG index.

- The nonce store is small and security-critical. Restoring a **stale** nonce store re-opens a
  replay window — after any restore, treat all outstanding approvals as spent and re-issue.
- The audit chain is append-only; verify the chain after every restore before accepting writes.
- The RAG index is derived and may be rebuilt (`pnpm run rag:reembed`) rather than restored.

Run a restore drill quarterly into a scratch environment and record the receipt. A backup that has
never been restored is a hypothesis, not a backup.

## 6. Revoking a JM endpoint

Until enrollment ships (Phase 4), revocation is operational:

1. Rotate `SANGFOR_OPERATOR_APPROVAL_SECRET` so the endpoint can no longer present valid approvals.
2. Remove the endpoint's console credentials at the customer console.
3. Have the operator run the teardown in the [install guide](JM_ENDPOINT_INSTALL.md#8-teardown-after-the-window)
   and delete project profiles.
4. Record the revocation in the audit ledger.

After Phase 4, revocation becomes a single identity revocation on BLRO, and a revoked identity is
refused before any job is issued.

## 7. Monitoring and alerting

Alert on:

| Signal | Why it matters | Response |
|---|---|---|
| `INDETERMINATE` mutation count > 0 | a device may have changed without proof | human verification of that device now |
| Audit chain verification failure | tampering or corruption | freeze writes, preserve the store, escalate |
| Approval secret read from an unexpected principal | credential compromise | rotate immediately, audit the window |
| Evidence upload failure backlog | customer deliverables at risk | drain before the endpoint's retention window expires |
| Endpoint preflight `NOT_READY` in the fleet | endpoints silently unable to work | re-run `pnpm run jm:endpoint:doctor` on that host |
| Queue age / disconnected endpoints (Phase 4) | jobs stranded after dispatch | treat dispatched-but-unacknowledged as `INDETERMINATE` |

`INDETERMINATE` is never auto-resolved and never retried automatically. It is escalated to a human
who verifies the device state directly.

## 8. Incident response

1. **Contain.** Unset `SANGFOR_ALLOW_REAL_EXECUTION` and `SANGFOR_ALLOW_PRODUCTION_EXECUTION`
   across the fleet. The system returns to read-only; no further mutation can be dispatched.
2. **Preserve.** Snapshot the audit chain, nonce store, and evidence manifests before any repair.
3. **Verify.** Re-verify the audit chain and the evidence hashes. Record what is provable and what
   is not; an unprovable step is reported as unprovable, never assumed good.
4. **Assess devices.** For every `INDETERMINATE` action in the window, verify the device state by
   independent read-back. Do not infer from the click log.
5. **Recover.** Restore the previous software artifact. Re-issue approvals with a rotated secret.
6. **Report.** Name the blast radius, the unprovable set, and the follow-ups. Do not round an
   unknown to "fine".

## 9. Capacity and scaling

JM endpoints scale horizontally by adding endpoints; each holds its own browser and profiles and
carries no shared state. BLRO scales its stateless request path first; the approval/nonce service
is the serialization point by design — single-use nonce consumption must remain strictly ordered,
so it is never sharded for throughput.

RAG retrieval scales by index, but scope filtering happens **before** ranking. Never move ACL
filtering after ranking to save a query; that leaks scores and identifiers across projects.

## 10. Not yet implemented

Stated plainly so nobody operates on an assumption:

- remote JM↔BLRO protocol, enrollment, certificate rotation, signed job tickets;
- multi-JM routing, queueing, retry semantics;
- authoritative store migration and backfill;
- production Postgres / object-store / vector-store topology;
- active-active BLRO storage.

Each is sequenced in [the separation plan](design-docs/blro-separation-and-operations.md).
Until they ship, BLRO is operated as the in-process authority described in sections 2-9.
