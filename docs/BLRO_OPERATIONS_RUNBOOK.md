# BLRO Operations Runbook

How to operate **BLRO**, the server-side authority for MCP, RAG, database, approvals, audit, and
evidence.

**Status:** Phase 4 library transport is shipped and lab-verified. Enrollment lifecycle,
Ed25519-signed single-use capabilities, exact certificate pinning, mutual TLS, idempotent job
handling, and fail-closed disconnect semantics are available. Production CA, host, and secret
manager wiring remain deployment-specific and are not implied by this document.

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

## 2b. Local development database

For a rootless PostgreSQL to develop and verify RLS against, see
[BLRO Local Database](BLRO_LOCAL_DATABASE.md). RLS isolation is proven there with
`pnpm run verify:rls` (expects `BLRO_RLS_ISOLATION_PASS`). Apply
`20260826170000_blro_runtime_stores` as the owner before starting control-tower.

Control-tower is the BLRO composition root. It requires `SANGFOR_BLRO_AUTHORITY_STORE=postgres`,
a credentialed PostgreSQL `DATABASE_URL`, tenant/project IDs, an Ed25519 private-key file at
`SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH`, a CA bundle at `SANGFOR_BLRO_TRUST_BUNDLE_PATH`, and
independent audit/operator secrets of at least 32 characters. There are no defaults or file-store
fallbacks. `/health` and `/live` report process liveness only; `/ready` checks config, database,
exact schema, project scope, signing material, trust material, and drain state. New authority work
is refused with 503 whenever readiness is false.

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
| `SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH` | Ed25519 authority signing key file | rotate through a drained key ceremony |
| `SANGFOR_BLRO_TRUST_BUNDLE_PATH` | trusted CA bundle for authority peers | rotate before peer certificate rollover |
| `SANGFOR_BLRO_AUDIT_SECRET` | authoritative audit-chain integrity | rotate only through a witnessed chain cutover |
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

### 5.1 Taking a backup

```bash
export BLRO_BACKUP_DATABASE_URL='postgresql://blro_backup:…@<host>:<port>/blro'
export BLRO_SCRATCH_ADMIN_DATABASE_URL='postgresql://backup_verify_admin:…@127.0.0.1:<port>/postgres'
pnpm run blro:backup --out /secure/backups --signing-key /secure/keys/backup-ed25519.pem
#                       …no --apply: dry run, prints BLRO_BACKUP_DRY_RUN and writes nothing
pnpm run blro:backup --out /secure/backups --signing-key /secure/keys/backup-ed25519.pem \
  --verification-scratch-target \
  'postgresql://backup_verify_admin:…@127.0.0.1:<port>/blro_scratch_backup_verify_<name>' --apply
# expect: BLRO_BACKUP_PUBLISHED
```

Dry run is the default. `--apply` is the only mutating path.

**The backup principal needs `BYPASSRLS`.** Every authoritative table is `FORCE ROW LEVEL
SECURITY`, which filters the *table owner* too. `pg_dump` run as `blro_owner` aborts with
`query would be affected by row-level security policy` — loudly, not silently, which is the point.
Use a dedicated read-only role:

```sql
CREATE ROLE blro_backup LOGIN PASSWORD '…' BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE blro TO blro_backup;
GRANT USAGE ON SCHEMA public TO blro_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO blro_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE blro_owner IN SCHEMA public GRANT SELECT ON TABLES TO blro_backup;
```

Never grant `BYPASSRLS` to the runtime role. The backup role has `SELECT` only and no DDL.

What the manifest records, all machine-derived from the live catalog and never hand-listed:
PostgreSQL version / system identifier / schema, the exact recovery-point LSN and timeline, the
applied migration set and a catalog digest, per-table row counts and order-independent set digests,
every foreign-key relationship with live child cardinality, project authority epochs and cutover
states, keyed audit-chain heads with a full chain digest, outstanding approvals and nonces
(nonce values appear only as SHA-256 digests), every remote-job tombstone including `INDETERMINATE`,
and the exact SHA-256 of every referenced evidence object.

The manifest is signed with an Ed25519 key **path**. The private key is read inside the signing
frame and never enters the output: only the SPKI digest of the public half is recorded. A manifest
is refused before writing if its bytes match any private-key PEM, credentialed URL, `PGPASSWORD`,
cookie header, or secret-shaped field.

Manifest capture and `pg_dump --snapshot=<internal-id>` share one exported PostgreSQL snapshot. The
exporting `REPEATABLE READ READ ONLY DEFERRABLE` transaction remains open until both finish, so a
concurrent commit is either in both artifacts or neither. The snapshot identifier and credentials
are never printed. The backup process also proves the reader is `BYPASSRLS`, non-superuser,
non-`CREATEDB`/`CREATEROLE`, and has no table-write or schema-create privilege.

An apply becomes publishable only after restoring the unsigned draft into the exact fresh loopback
`blro_scratch_backup_verify_*` target owned by `BLRO_SCRATCH_ADMIN_DATABASE_URL`. The shared
PRE-recovery verifier requires zero differences across schema and migrations, all 56 tables and set
digests, all 117 relationships and cardinalities, keyed audit/evidence objects, epochs, and authority
tombstones. It applies no recovery policy and drops the owned scratch database before signing.
Only then are canonical signed manifest and dump atomically renamed into the output directory. Any
capture, session, dump, restore, equality, signing, rename, or scratch-drop error quarantines the
draft and emits no publication sentinel or receipt.

### 5.2 RPO contract — what is and is not promised

**The quarterly dump alone never justifies RPO=0.** Two distinct claims:

| Situation | RPO for committed job / nonce / audit authority |
|---|---|
| Restore from the dump alone | equals the **age of the dump**. Not zero. |
| Synchronous durability proven live | zero for committed authority; the dump is the fallback floor |

RPO=0 is a property of the settings below, machine-checked against `pg_settings` on every backup,
not of the existence of a dump file:

| Setting | Required | Why |
|---|---|---|
| `synchronous_commit` | `remote_apply` or `on` | a COMMIT must not be acknowledged before its WAL is durable at the synchronous quorum |
| `synchronous_standby_names` | non-empty | an empty value acknowledges commits with no synchronous replica |
| `wal_level` | `replica` or `logical` | streaming replication and PITR both need WAL beyond minimal |
| `fsync` | `on` | without it a crash loses acknowledged commits regardless of replication |
| `full_page_writes` | `on` | torn pages make the recovery point unusable |
| `archive_mode` | `on` or `always` | the gap between dumps is closed only by continuously archived WAL |
| live sync replicas | ≥ 1 in `sync`/`quorum` | settings without a standby prove nothing |

`--mode production` **fails closed** with `BLRO_RPO_SYNC_DURABILITY_UNPROVEN` when any of these is
absent. `--mode task` (the default) records the same findings honestly and still publishes: a task
cluster is a backup point, and the manifest says so in `rpo.claim`.

**Backup-point semantics.** The manifest state and custom dump are read from one exported snapshot.
A transaction visible when that snapshot is established appears in both; a later commit appears in
neither. The internal publication restore proves full equality, and the quarterly drill independently
requires total committed rows after restore to equal the manifest's or halts with
`BLRO_DRILL_RECOVERY_POINT_COMMITS_LOST`.

### 5.3 Retention

| Field | Value |
|---|---|
| Owner | BLRO authority operations (single accountable owner) |
| Schedule | full dump quarterly + before every schema cutover; WAL archive continuous; restore drill quarterly |
| Storage class | object storage, server-side encryption, versioning, cross-region replication |
| WORM | object-lock in compliance mode for the full window; no principal may shorten or delete within it |
| Hash audits | manifest + dump SHA-256 re-verified monthly against stored objects; a mismatch freezes the object and escalates |
| Retention | full dump 400 days · WAL archive 35 days · drill receipts 400 days |

**Explicitly excluded from every backup and receipt**: private signing keys, browser cookies and
session state, customer console credentials, operator/audit/approval HMAC secrets, and any bearer
token or API credential. This exclusion is enforced by the secret-material gate, not by convention.

### 5.4 Running the restore drill

```bash
export BLRO_BACKUP_DATABASE_URL='postgresql://blro_backup:…@<host>:<port>/blro'
export BLRO_SCRATCH_ADMIN_DATABASE_URL='postgresql://postgres@127.0.0.1:<port>/postgres'
export SANGFOR_BLRO_AUDIT_SECRET='…'   # ≥32 chars; keys the recovery audit event

pnpm run blro:restore-drill \
  --backup-dir /secure/backups --backup-id <id> \
  --public-key /secure/keys/backup-ed25519.pub.pem \
  --signing-key /secure/keys/backup-ed25519.pem \
  --scratch-target 'postgresql://postgres@127.0.0.1:<port>/blro_scratch_<name>' \
  --receipt-out /secure/receipts/<id>.json
# expect the final line: BLRO_RESTORE_DRILL_PASS
```

**There is no production target path in this program.** `--scratch-target` is mandatory and must be
a loopback host with a database name carrying the reserved `blro_scratch_` prefix, and must not
equal the source. A target that already exists is refused as dirty rather than overwritten.

Gates that run **before any database is created**, in order: manifest signature, dump byte length,
dump SHA-256, `pg_restore --list` readability and table coverage, every referenced evidence object's
existence and exact hash, and schema compatibility against the working tree's migration set (stale
in either direction refuses). Any failure halts non-zero having created nothing.

After restore the drill re-derives the full captured state from the scratch target with the same
code the backup used and requires 100% equality: every table's row count and set digest, every FK
relationship and child cardinality, every audit chain head and chain digest, every epoch, every
evidence-object hash, and the remote-job tombstone set. RTO is measured on a monotonic clock and
must be ≤ 60 minutes.

### 5.5 Recovery policy — applied only in scratch, after equality

A restored authority store is stale by construction: every approval and nonce in it was minted
before the recovery point and may already have been spent against the lost primary. So, atomically
per project, inside one serializable transaction:

1. bump the project authority epoch (and its revision);
2. spend every outstanding approval and consume every unconsumed nonce — **spent, never deleted**;
3. preserve every completed and `INDETERMINATE` remote-job tombstone and result byte-exact;
4. append one keyed `blro.recovery.policy.applied` audit event to the chain head.

The policy runs **only** after the equality proof is clean. It then reads its own effect back and
proves the replay refusals it claims: an approval, nonce, and capability JTI carried over from
before the recovery point must refuse with `AUTHORITY_EPOCH_STALE`, `APPROVAL_ALREADY_SPENT`,
`NONCE_ALREADY_USED`, and `JTI_TOMBSTONED`.

**`INDETERMINATE` is never reset, deleted, or promoted to `PASS`.** A device may have changed
without proof; only a human read-back resolves it (§8). Converting or dropping an uncertain job
halts the drill with `BLRO_RECOVERY_UNCERTAINTY_CONVERTED`.

The drill emits a signed receipt and prints `BLRO_RESTORE_DRILL_PASS` as its final line. Cleanup
drops exactly the scratch database it created and removes the temporary dump; the manifest and
receipt hashes are what is retained.

**Promotion and rollback remain manual.** Nothing in the drill promotes a restore to production or
rolls anything back — that is §3's human decision, unchanged.

## 6. Revoking a JM endpoint

1. Call `EnrollmentRegistry.revoke(installationId, reason)` in the BLRO enrollment authority.
2. Confirm `evaluateForJob(installationId)` returns `ENROLLMENT_REVOKED`.
3. Confirm the JM certificate fingerprint is absent from the mTLS server's authorized-client set.
4. Remove the endpoint's console credentials at the customer console.
5. Have the operator run the teardown in the
   [install guide](JM_ENDPOINT_INSTALL.md#8-teardown-after-the-window).

Rotation uses `EnrollmentRegistry.rotate()`. The prior serial becomes `superseded` immediately.
A revoked identity is refused before capability verification or browser execution.

## 7. Remote JM configuration

BLRO uses the normal in-process runtime unless `SANGFOR_REMOTE_BROWSER_URL` is set. Remote mode
fails closed unless every setting below is present:

- tenant/project, installation identity, and client identity;
- BLRO Ed25519 capability signing private-key **file path**;
- BLRO mTLS client certificate/key **file paths**;
- trusted CA certificate path;
- exact JM server-certificate SHA-256 fingerprint.

The private signing key stays on BLRO. JM receives only the public verify key during enrollment.
The transport performs one POST and never retries. A lost or malformed response after dispatch is
`INDETERMINATE`, not `PASS`.

## 8. Monitoring and alerting

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

## 9. Incident response

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

## 10. Capacity and scaling

JM endpoints scale horizontally by adding endpoints; each holds its own browser and profiles and
carries no shared state. BLRO scales its stateless request path first; the approval/nonce service
is the serialization point by design — single-use nonce consumption must remain strictly ordered,
so it is never sharded for throughput.

RAG retrieval scales by index, but scope filtering happens **before** ranking. Never move ACL
filtering after ranking to save a query; that leaks scores and identifiers across projects.

## 11. Not yet implemented

Stated plainly so nobody operates on an assumption:

- multi-JM routing, queueing, retry semantics;
- enrollment and JM receipt service routes (the Postgres adapters are composed but not remotely exposed until Phase 26);
- authoritative historical backfill;
- production Postgres / object-store / vector-store topology;
- active-active BLRO storage.

Each is sequenced in [the separation plan](design-docs/blro-separation-and-operations.md).
Until they ship, BLRO is operated as the in-process authority described in sections 2-9.
