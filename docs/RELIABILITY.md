# Reliability

Reliability here means: a change either **provably** happened (verified by read-back and recorded) or it **safely halted for a human**. There is no in-between, and there is no silent success.

## Core invariants (enforced in code)
1. **A 2xx is not success.** Vendor APIs (e.g. HCI) return 202 even when nothing changed (quota exceeded). Success is only an independent **read-back PASS** (`@sangfor/hci-client` `read-back.ts`).
2. **INDETERMINATE ≠ PASS.** Ambiguous/absent/still-creating read-back → FAIL or INDETERMINATE, never counted as success.
3. **No automatic rollback.** The apply state machine (`PENDING → VALIDATING → APPLYING → VERIFYING → SUCCEEDED | FAILED_HALT`) halts on failure and calls a human; it never auto-reverts.
4. **Idempotency.** Writes carry an `X-Client-Token` idempotency key (≥8 chars) so a retried request cannot double-apply.
5. **Fail-closed dependencies.** A service missing from the Keystone catalog, a corrupt safety/nonce/ledger file, or an ambiguous UI locator (0 or >1 matches) → refuse, don't guess.
6. **Read-only never mutates.** `@sangfor/verifier` throws if asked to `apply` without `SANGFOR_ALLOW_REAL_EXECUTION`; config collection is always `{readOnly:true, mutationBlocked:true}`.
7. **Remote dispatch is at most once, never exactly once.** BLRO atomically commits a scoped capability JTI and permanent dispatch tombstone before calling the external executor. Pre-commit failure is retryable; every post-tombstone path without a digest-verified retained result is `INDETERMINATE` and is never redispatched automatically.

## Evidence & auditability
- Every apply step is written to a **hash-chained audit ledger** (`data/evidence/change-runs/<runId>.jsonl`): `request | response | state | verdict`.
- The **run ledger** (`data/runs/YYYY-MM-DD.jsonl`, `@sangfor/runs`) is append-only, date-partitioned, last-line-wins; captures `toolId`, `toolSafety`, masked args, status (incl. `pending_approval`/`rejected`), and the approval block.
- Before/after **screenshots** land under `data/evidence/<sessionId>/` for browser-driven actions (captured even on live dry-run, which stops before the click/type).

## Backup, RPO and restore drills
- **Publication is a restore proof, not an archive check.** `scripts/blro-backup.mjs` captures manifest state and `pg_dump` from one exported read-only snapshot, restores the unsigned draft into a fresh reserved loopback scratch database, and requires the shared PRE-recovery verifier to report zero differences before signing or atomic final rename. Scratch teardown completes first; any failure leaves only quarantined temporary bytes and no publication sentinel.
- **RPO is never rounded down.** A quarterly custom-format dump gives an RPO equal to the age of the dump, and the manifest says exactly that. RPO=0 for committed job/nonce/audit authority is claimed only when synchronous commit, a non-empty synchronous standby set, `wal_level` ≥ `replica`, `fsync`, `full_page_writes`, `archive_mode`, **and** at least one live in-sync replica are all machine-checked against `pg_settings`. `--mode production` fails closed with `BLRO_RPO_SYNC_DURABILITY_UNPROVEN` when they are not.
- **Commits before the recovery point are proven present, not assumed.** The manifest records the LSN observed while the dump snapshot was open; the drill requires total committed rows after restore to equal the manifest's, or halts with `BLRO_DRILL_RECOVERY_POINT_COMMITS_LOST`.
- **The drill proves the whole chain or halts.** `scripts/blro-restore-drill.mjs` verifies signature, dump hash, dump readability, evidence-object hashes, and schema compatibility *before* creating any database; then restores into a fresh loopback `blro_scratch_*` database and requires 100% equality of tables, set digests, FK relationships and cardinalities, audit chain heads, epochs, and evidence hashes. RTO is measured on a monotonic clock against a 60-minute budget, and it prints `BLRO_RESTORE_DRILL_PASS` only on success.
- **Recovery policy never launders uncertainty.** In scratch only, and only after the equality proof is clean, it bumps the authority epoch and spends every outstanding approval and nonce so pre-recovery-point authority refuses on replay — while preserving every completed and `INDETERMINATE` remote-job tombstone byte-exact. Converting or deleting an `INDETERMINATE` job halts the drill.
- **No auto promotion or rollback.** The drill has no production target path; promotion remains the human decision in [BLRO Operations Runbook §3](BLRO_OPERATIONS_RUNBOOK.md#3-deploy-and-upgrade).

## Availability & degradation
- **Offline-safe knowledge**: if an embedding provider fails its health check or times out (`SANGFOR_EMBEDDING_INIT_TIMEOUT_MS`, default 5000ms), the deterministic hash provider takes over so ingest/search keep working.
- **Token resilience**: `KeystoneV2TokenProvider` caches tokens with a 60s refresh margin and forces exactly one re-auth on a 401.
- **Concurrency guard**: `@sangfor/pm` `DeviceLock` prevents two engagements from operating the same device concurrently. Control-tower sweeps cap concurrency (3) and force-fail any non-read-only tool in a sweep.

## Known reliability gaps
Learning-loop state (feedback/lessons, eval cases, wiki proposals) is now persisted to file-backed JSONL (`@sangfor/shared` `appendJsonl`/`foldJsonlById`, env-overridable roots), so it survives a restart.

Control-tower **paused-block original args are intentionally not persisted**: writing an un-masked arg to disk would violate mask-before-persist. A playbook write-block recovers after a tower restart by re-deriving its args from the immutable revision + persisted results (`reinterpretBlockArgs`); a **single-tool** paused write has no such source, so its approval is deliberately unrecoverable after a restart (`approveRun` returns 400) — safe by design, not a bug to "fix" by persisting secrets.

## Operational runbooks (existing)
- [DEVICE_DIAGNOSIS_RUNBOOK.md](DEVICE_DIAGNOSIS_RUNBOOK.md), [M4_HCI_API_SPIKE_RUNBOOK.md](M4_HCI_API_SPIKE_RUNBOOK.md), [LOCAL_SETUP.md](LOCAL_SETUP.md).

## SLO posture
No formal SLOs yet (single-operator, lab/PoC stage). The de-facto reliability contract is the invariants above: correctness and safety are prioritized over throughput. If SLOs are introduced, anchor them on read-back-verified apply success rate and mean-time-to-human-halt, not on request 2xx rate.
