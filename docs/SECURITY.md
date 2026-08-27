# Security

Security is the defining property of this repo — it drives real device changes for customers. **Read this before touching any write, execution, approval, bind, or persistence path.** The governing belief: a confidently-wrong or replayable action is worse than no action.

## Threat model (what we defend against)
- An errant/misconfigured caller mutating a **production** device.
- A leaked or **replayed** approval token authorizing a write.
- An approval minted for action A being **reused** for action B.
- A server accidentally exposed on a **non-loopback** interface without auth.
- **Secrets** (passwords, tokens, cookies) leaking into logs, ledgers, or fine-tune data.
- A vendor 2xx being mistaken for a successful change (**false PASS**).

## The live-execution gate (canonical, in `@sangfor/operator`)
A non-dry-run live write passes `assertRealExecutionAllowed()` only if **all** hold, in order:
1. Not a dry-run (`action.dryRun !== false` means dry-run → returns before mutation).
2. `SANGFOR_ALLOW_REAL_EXECUTION=true`.
3. `SANGFOR_ALLOW_PRODUCTION_EXECUTION=true` for `production` mode **or any
   non-loopback mutation target**. Caller-selected `lab`/`poc` labels never
   downgrade a remote target.
4. **Complete-action-bound HMAC approval** — `approvalToken = HMAC-SHA256(SANGFOR_OPERATOR_APPROVAL_SECRET, approvedBy · changeTicketId · rollbackPlanId · nonce · expiresAt · canonicalActionJson)`, verified with `timingSafeEqual`. Canonical JSON recursively sorts keys and includes every supplied action field; browser writes therefore bind `type`, `target`, `value`, `dryRun`, `menuPath`, and `formFields`. Missing secret → **fail closed**. A token cannot be reused after changing any action value or browser field.
5. **Single-use nonce** — one selected durable store consumes `(nonce, expiresAt)`; replay within the window is rejected. Store error → refuse. `SANGFOR_NONCE_STORE` picks it: unset/`file` → `FileNonceStore` (`data/runtime/approval-nonces.json`, atomic tmp+rename, single-process safe); `postgres` → `PostgresSingleUseNonceStore` (`BlroApprovalNonce`, UNIQUE + `ON CONFLICT DO NOTHING`, scoped by `project_id` under RLS, replica safe). Selection is **fail-closed**: a missing connection string, a missing project scope, an unknown store name, or an unreachable database refuses — it never falls back to the file store, and the synchronous entry point refuses outright while a non-file store is selected, so the control can never mean "once per store". All three call sites (operator gate, MCP HCI write gate, http-bridge tool guard) consume through this one selection. Browser writes consume the nonce only after target/origin/request validation and an authoritative read-only preflight, immediately before mutation dispatch.
6. **Origin lock** — `assertNavigationWithinTarget` refuses a cross-origin navigate even under dry-run.

Mandatory approval fields: `approvedBy`, `approvalToken`, `changeTicketId`, `rollbackPlanId`, `nonce`, `expiresAt` (+ optional `maintenanceWindow`). No rollback plan → no approval.

## Remote-job dispatch authority

In BLRO production, `PostgresRemoteJobStore` is the only remote-job authority. A current enrolled client certificate, exact origin/scope grant, and an Ed25519 capability bound to the full request are verified before retained job state is consulted. The capability JTI and first dispatch tombstone commit atomically; only after that transaction commits may the external executor run. There is no memory or file fallback. A used JTI, request-digest conflict, revoked or superseded enrollment, wrong certificate, wrong origin/scope, or invalid capability refuses without dispatch or retained-result disclosure.

This is deliberately **at-most-once dispatch, not exactly-once delivery**. A crash after the tombstone commit can prevent delivery, and a crash or acknowledgement loss after dispatch can hide the result. Either case remains `INDETERMINATE` and is never automatically redispatched. Tombstones have no expiry or deletion path; an exact authorized duplicate can return only a digest-verified retained result.

A mutation response is never authoritative PASS. Final PASS requires a distinct, separately authorized and separately tombstoned/JTI-bound read-only `verify_console` job whose independent read-back is PASS. A refused, mismatched, unavailable, or indeterminate verification remains non-PASS, and no path automatically retries the mutation or rolls it back.

## The second, independent gate (`apps/http-bridge/tool-guard.ts`)
Defense-in-depth for the REST surface:
- Tools with **missing annotations** → 403 (fail closed).
- `destructiveHint` tools **without an approval** → refused unconditionally: the whitelist toggle, a loopback bind and every other flag cannot lift this.
- `destructiveHint` (and write) tools **with** a valid `SignedApproval` bound to `{type:'bridge.tool-call', target:<tool name>}` → permitted **for that one call**. This is the only path by which the Control Tower executes an approved run, and it is why "always refused" is not the contract. Pinned by `tests/http-bridge-approval-guard.test.ts` ("destructive ALWAYS refused without approval" / "valid approval allows a destructive tool").
- Write tools on a **non-loopback** bind → refused unless `SANGFOR_ALLOW_REMOTE_WRITE=true`, **even with a valid approval**.
- The nonce is `consume`d **last** (after all other checks pass), so a refused call never burns a single-use approval.

A destructive HCI tool therefore needs **two independent approvals** over HTTP: the bridge-level `bridge.tool-call` approval above, plus the tool's own action-bound approval (`hci.delete-volume` for `sangfor_hci_delete_volume`). On a **non-loopback** target, `hciWriteGate` additionally requires `SANGFOR_ALLOW_REAL_EXECUTION=true`, exact `fieldVerifiedAutoAllowed` safety, and active Todo 10 evidence for the exact scope. The general MCP surface cannot supply evidence claims, so it fails closed until authenticated evidence authority is wired; `volume_create`/`volume_delete` remain unavailable on real targets.

The sole pre-promotion exception is the internal O1 IAG evidence campaign bootstrap. It accepts only one lab/non-production `internet_policy` URL/application exception at `tested_mock`, a completed green loopback mock campaign with all five negative cases, exact device/firmware/window/session/origin/campaign IDs, no active field evidence, **both** `SANGFOR_ALLOW_REAL_EXECUTION=true` and `SANGFOR_ALLOW_PRODUCTION_EXECUTION=true`, and a dedicated action-bound `purpose=evidence_bootstrap` approval. A lab/non-production label never downgrades a non-loopback origin. Maturity, mock completion, negatives and active-evidence absence are derived internally from a grounded manifest/context, Todo 8 validation, and the authenticated promotion ledger/checkpoint; callers cannot submit those decisions. The manifest and promotion bind a privacy-preserving digest of the exact canonical target origin alongside device identity. HCI and IAG recompute that digest from the requested canonical origin and require equality before nonce use; scheme, host or non-default-port retargeting refuses. Its nonce is consumed only after every preflight succeeds. The result is always candidate-only (`promotionEligible:false`), cannot alter maturity or authorize another action, and this seam is not registered as an MCP/HTTP tool.

## Network exposure (`@sangfor/shared`)
- `assertBindSafety` **fails closed**: binding a non-loopback host **requires** a token (`SANGFOR_API_TOKEN`). An empty/whitespace `BIND_HOST` must not silently become an all-interfaces bind.
- `checkAuth` is a constant-time bearer comparison. All app servers (`mcp`/`bridge`/`control-tower`/`operator-console`) route through these helpers.
- Control Tower enrollment lifecycle routes are stricter: they require a configured `SANGFOR_API_TOKEN` even on loopback and accept requests only when the actual peer socket is in `127.0.0.0/8`, `::1`, or IPv4-mapped `127.0.0.0/8`. They are unavailable while BLRO authority is unready and never bind enrollment mutations to a non-loopback peer.

## Secret handling
- `maskSecrets` redacts `password|secret|token|authorization|cookie` → `***` **before** anything is written to a run ledger, audit ledger, or console.
- Fine-tune datasets run a secret-blocking regex (`validateFineTuneDataset`); collection sanitizes PII (email/phone/password/OTP/MFA/license) before export.
- `.env` is gitignored; `.env.example` documents vars without values. Never commit real credentials or lab tokens.

## Tamper-evidence
- Change runs (`data/evidence/change-runs/*.jsonl`), the run ledger (`data/runs/*.jsonl`), and PM events are **append-only and hash-chained**. Keyed HMAC chains when `SANGFOR_CHANGE_LEDGER_SECRET` / `SANGFOR_PM_CHAIN_SECRET` are set; otherwise unkeyed SHA-256 and `verify()` honestly reports `keyed:false`.
- After a project is cut over with `SANGFOR_BLRO_AUTHORITY_STORE=postgres`, the
  superseded JM registry, run, approval, nonce, audit/evidence, and RAG writers
  fail closed. They never fall back to local files or in-memory state. Configure
  `SANGFOR_NONCE_STORE=postgres`, `DATABASE_URL`, and `SANGFOR_PROJECT_ID`
  together; a partial configuration is a refusal.

## Backup and restore-drill trust boundary
- Backups run as a dedicated `BYPASSRLS`, `SELECT`-only `blro_backup` role. Runtime verifies the role is non-superuser, cannot create roles/databases/schema objects, and has no table-write privilege before exporting one `REPEATABLE READ READ ONLY DEFERRABLE` snapshot for manifest capture and `pg_dump`. The runtime role never gets `BYPASSRLS`, and RLS is never weakened.
- The backup manifest and drill receipt are signed with an Ed25519 key **path**. The private key is read inside the signing frame and never enters output; only the SPKI digest of the public half is recorded.
- Published bytes pass a machine gate (`assertNoSecretMaterial`) that refuses private-key PEMs, credentialed connection URLs, `PGPASSWORD`, cookie headers, and secret-shaped fields. Approval nonces appear only as SHA-256 digests, never as values.
- Connections are rendered as `host:port/database` only. Credentials reach `pg_dump`/`pg_restore`/`psql` through `PGPASSWORD` in the child environment, never on a command line, and tool output is scrubbed before it is surfaced.
- Evidence-object paths are containment-checked against the evidence root: traversal, symlink escape, and NUL bytes are refused. A referenced object that is missing or whose bytes changed is a refusal — the code never synthesises a hash.
- Backup apply and restore drill have **no production target path**. Apply requires the exact local admin identity and a fresh `blro_scratch_backup_verify_*` target; it restores and proves the unsigned draft before signing. The drill requires a fresh loopback `blro_scratch_*` target. Neither promotes or rolls back anything, and each drops only the database it created.
- The recovery policy spends outstanding approvals and nonces and bumps the project epoch so pre-recovery-point authority refuses on replay. It never deletes them, and it never resets, deletes, or promotes an `INDETERMINATE` remote job.

## Knowledge/data trust
- BLRO RAG authority is project-scoped PostgreSQL/pgvector: tenant/project/actor, ACL, trust, source, product, and version predicates execute in SQL before vector ranking. Exact search remains authoritative/default. HNSW routing requires a current digest-verified persisted promotion and an OID/relfilenode/definition/name/table/operator-class/validity-bound preflight token. Candidate EXPLAIN, query, and fresh post-query identity check run in one READ COMMITTED transaction; only a predispatch missing-index condition may visibly use exact. Candidate timeout/error/partial decode, plan mismatch, or identity replacement is typed unavailable with no exact retry or result mixing. Missing extension/schema/database is typed unavailable and never empty success or local JSON fallback. Cloud embeddings/rerank still need `SANGFOR_ALLOW_CLOUD_RAG`; customer-trust docs remain excluded unless `SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER=1`.
- Wiki writes are review-gated: proposal → `approveWikiUpdate` (action-bound HMAC over the `proposalId`, keyed by `SANGFOR_WIKI_APPROVAL_SECRET`, timing-safe verify, fail-closed if unset) → apply.
- Capability maturity changes are event-derived, human-only decisions. They use the dedicated `SANGFOR_CAPABILITY_PROMOTION_SECRET` domain, an append-only decision ledger keyed separately by `SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET`, an independently keyed durable head (`SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET`), and an existing single-use nonce store. Only a fully verified ledger/head pair yields maturity; uncertain append acknowledgement reports INDETERMINATE. They never rewrite the curated catalog/policy, reuse operator/wiki keys, create missing authority stores at runtime, or auto-promote active evidence.

## Rules for agents working here
- **Never weaken a gate to make a test pass.** The refusal *is* the feature; dedicated tests assert it (`operator-execution-gate`, `operator-nonce-store`, `verifier-apply-gate`, `http-bridge-approval-guard`, `operator-console-auth`).
- New write/execution capability must route through `assertRealExecutionAllowed` (or an equivalently strong action-bound HMAC), consume a single-use nonce, and mask secrets before persistence.
- Any new server bind must go through `assertBindSafety`; any new persisted record through `maskSecrets`.
- When in doubt, **refuse and surface** rather than proceed.

## Security env vars (gates & secrets)
`SANGFOR_ALLOW_REAL_EXECUTION`, `SANGFOR_ALLOW_PRODUCTION_EXECUTION`, `SANGFOR_OPERATOR_APPROVAL_SECRET`, `SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET`, `SANGFOR_ALLOW_REMOTE_WRITE`, `SANGFOR_API_TOKEN`, `SANGFOR_BLRO_AUTHORITY_STORE`, `SANGFOR_NONCE_STORE`, `SANGFOR_NONCE_STORE_PATH`, `SANGFOR_PROJECT_ID`, `DATABASE_URL`, `SANGFOR_CHANGE_LEDGER_SECRET`, `SANGFOR_PM_CHAIN_SECRET`, `SANGFOR_WIKI_APPROVAL_SECRET`, `SANGFOR_CAPABILITY_PROMOTION_SECRET`, `SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET`, `SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET`, `SANGFOR_CAPABILITY_PROMOTION_NONCE_STORE_PATH`, `SANGFOR_CAPABILITY_PROMOTION_LEDGER_PATH`, `SANGFOR_ALLOW_CLOUD_RAG`, `SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER`, `BLRO_BACKUP_DATABASE_URL`, `BLRO_SCRATCH_ADMIN_DATABASE_URL`, `SANGFOR_BLRO_AUDIT_SECRET`. See `.env.example` for the full set.
