# BLRO authority cutover runbook

## Safety invariants

All 22 canonical local writers use an async injected `LocalWriteFencePort`. Before bytes mutate, the PostgreSQL fence commits a scoped `PENDING` intent containing tenant/project/actor/aggregate/epoch/source-root, operation digest, target paths, and preimage digests under the project+aggregate lock. After mutation it commits exact postimage digests as `COMPLETED`; uncertain outcomes remain `PENDING` until explicitly reconciled. Freeze refuses every pending intent before parity capture.

PostgreSQL is the cutover-state and canonical project-epoch authority. Environment selectors never choose local authority. Freeze recaptures source bytes, reads the real product target, and fsyncs an exact-scoped local safety marker under the shared lock before `FROZEN` commits. Every writer checks that marker after restart. No migration command changes source bytes, and rollback is impossible at or after `FROZEN`.

## Adapter policy inventory

The registry is exhaustive against the 17 authoritative Todo20 entries and each entry's exact target tables.

- `backfill`: `registry_services`, `runs_steps`, `audit`, `evidence`, `pm_tasks`, `feedback_lessons`, `evals`, `wiki_proposals`, `learning_strategy_lifecycle`, `config_chronicle_state`, `capability_evidence_promotion`
- `invalidate_on_cutover`: `approvals_nonces`, `browser_job_authority`
- `postgres_native`: `tenant_identity`, `project_installation_identity`, `rag_source_chunks`, `firmware_version_evidence`

Backfill adapters require the operator-declared exact native file set, reject traversal and root/component/file symlinks, retain tenant/project/source-root/path/ordinal/source-SHA provenance, reject duplicate keys, verify chains/generations/content addresses/HMAC checkpoints, and upsert/read back only the declared product tables. Invalidation adapters atomically spend or make old-epoch authority indeterminate during freeze. Native adapters require their declared tables and project-scoped identity/enrollment prerequisites.

## CLI sequence

The default command is `plan`; only `status`, `plan`, and `read-intent` are read-only. `backfill`, `shadow`, `freeze`, `promote`, `rollback`, and `reconcile` require `--apply`. Every mutation requires tenant/project/actor/aggregate/source-root, expected revision and epoch, and phase-specific digest/HWM/fence or intent expectations. Unknown or duplicate flags, omitted native files, dirty Git sources, malformed bytes, stale expectations, and database failures return `INDETERMINATE` non-zero.

```sh
export DATABASE_URL='postgresql://...'
# Audit and capability migrations additionally require their existing HMAC secrets:
export SANGFOR_CHANGE_LEDGER_SECRET='...'
export SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET='...'
export SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET='...'

COMMON='--tenant TENANT_ID --project PROJECT_ID --aggregate evals \
  --actor ACTOR_ID --source-root /immutable/task-source \
  --source-files eval-cases.jsonl'
EXPECT='--expected-epoch 0 --expected-hwm DIGEST \
  --expected-source-digest DIGEST --expected-target-digest DIGEST'

# Capture only. Retain its exact digest/HWM and record count.
pnpm exec tsx scripts/blro-migrate-authority.ts plan $COMMON

# Stage, verify parity, and enter SHADOW_READING (revision 0 -> 2).
pnpm exec tsx scripts/blro-migrate-authority.ts backfill $COMMON $EXPECT \
  --expected-revision 0 --apply

# Independent shadow parity check; no state revision change.
pnpm exec tsx scripts/blro-migrate-authority.ts shadow $COMMON $EXPECT \
  --expected-revision 2 --apply

FENCE_AT='2026-08-26T03:00:00.000Z'
pnpm exec tsx scripts/blro-migrate-authority.ts freeze $COMMON $EXPECT \
  --expected-revision 2 --at "$FENCE_AT" --apply

pnpm exec tsx scripts/blro-migrate-authority.ts promote $COMMON $EXPECT \
  --expected-revision 3 --at "$FENCE_AT" --apply
```

Promotion succeeds only after a committed readback of `POSTGRES_PRIMARY` and the incremented epoch. Its machine-consumed sentinel is `BLRO_CUTOVER_PASS`.

## Rollback boundary

Before freeze, rollback removes cutover-owned target/checkpoint rows and the exact safety marker under the shared lock, then returns state to `LOCAL_PRIMARY`. It requires the same exact scope plus expected revision and epoch:

```sh
pnpm exec tsx scripts/blro-migrate-authority.ts rollback \
  --tenant TENANT_ID --project PROJECT_ID --aggregate evals --actor ACTOR_ID \
  --source-root /immutable/task-source --expected-revision REV --expected-epoch EPOCH --apply
```

`FROZEN` and `POSTGRES_PRIMARY` always return `CUTOVER_ROLLBACK_REFUSED`. For an uncertain local write, use `read-intent` with the exact actor, source root, operation digest, and preimage digest. Use `reconcile --apply` only with the write ID, expected revision/epoch, operation/preimage/postimage digests, and explicit `COMPLETED` or `ABORTED` resolution. Never infer success from disconnect and never restore local authority after the fence.

## Operator evidence

For every task migration retain: plan output, source tree hashes before/after, backfill and shadow output, expected digest/epoch, freeze output, promotion readback containing `BLRO_CUTOVER_PASS`, RLS verifier output, and cleanup confirmation. A mismatch or chain gap must be demonstrated on a disposable copy only; never alter production source to test refusal.
