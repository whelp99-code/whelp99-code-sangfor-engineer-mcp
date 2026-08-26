// Honest RPO contract for committed BLRO job / nonce / audit authority.
//
// A quarterly custom-format dump is a *backup point*, not continuous durability. RPO=0 for
// committed authority is a property of synchronous commit to at least one standby plus archived
// WAL — never of the dump alone. This module states the required settings and machine-checks them
// against live `pg_settings`, so "RPO0" is a decision the catalog makes, not prose in a runbook.

export const RPO_CONTRACT_ID = 'blro.rpo.contract/1';

export class BlroDurabilityError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'BlroDurabilityError';
    this.code = code;
  }
}

/**
 * Required production settings for the RPO=0 claim over committed authority.
 * `accepted` is the exact set of values that keep the claim true; anything else is a finding.
 */
export const REQUIRED_SYNC_DURABILITY = Object.freeze([
  Object.freeze({
    setting: 'synchronous_commit',
    accepted: Object.freeze(['remote_apply', 'on']),
    reason: 'a COMMIT must not be acknowledged before its WAL is durable at the synchronous quorum',
  }),
  Object.freeze({
    setting: 'wal_level',
    accepted: Object.freeze(['replica', 'logical']),
    reason: 'streaming replication and PITR both require WAL beyond minimal',
  }),
  Object.freeze({
    setting: 'fsync',
    accepted: Object.freeze(['on']),
    reason: 'without fsync a crash loses acknowledged commits regardless of replication',
  }),
  Object.freeze({
    setting: 'full_page_writes',
    accepted: Object.freeze(['on']),
    reason: 'torn pages after a crash make the recovery point unusable',
  }),
  Object.freeze({
    setting: 'archive_mode',
    accepted: Object.freeze(['on', 'always']),
    reason: 'the gap between dumps is only closed by continuously archived WAL',
  }),
]);

/** The dump alone can never justify RPO=0; this is the claim printed for a backup point. */
export const BACKUP_POINT_SEMANTICS = Object.freeze({
  backupPoint: 'The manifest records the exact pg_current_wal_lsn observed while the dump snapshot was open. Every transaction committed at or before that LSN is inside the dump.',
  dumpAloneClaim: 'RPO for a restore from this dump alone equals the age of the dump. It is NOT zero.',
  rpoZeroClaim: 'RPO=0 for committed job/nonce/audit authority holds only while synchronous replication and WAL archiving are proven live; the dump is the fallback floor, not the guarantee.',
  neverClaimed: 'Continuous RPO=0 is never claimed from a quarterly dump.',
});

/** Retention policy. Names the owner, schedule, storage class and the exclusion set. */
export const RETENTION_POLICY = Object.freeze({
  owner: 'BLRO authority operations (single accountable owner; see BLRO Operations Runbook §5)',
  schedule: Object.freeze({
    fullDump: 'quarterly, plus before every schema cutover',
    walArchive: 'continuous while archive_mode is on',
    restoreDrill: 'quarterly into a scratch target, receipt retained',
  }),
  storageClass: 'object storage with server-side encryption, versioning enabled, cross-region replication',
  worm: 'object-lock in compliance mode for the full retention window; no principal may shorten or delete within it',
  hashAudits: 'manifest sha256 + dump sha256 re-verified monthly against stored objects; a mismatch freezes the object and escalates',
  retention: Object.freeze({ fullDump: '400 days', walArchive: '35 days', driftReceipts: '400 days' }),
  excluded: Object.freeze([
    'private signing keys (Ed25519 authority/backup keys)',
    'browser cookies and session state',
    'customer console credentials',
    'operator/audit/approval HMAC secrets',
    'any bearer token or API credential',
  ]),
});

/**
 * Machine-check live settings against the contract.
 * @param {ReadonlyArray<{name: string, setting: string}>} settings live pg_settings rows
 * @param {number} syncReplicaCount count of walsenders in sync/quorum state
 */
export function evaluateSyncDurability(settings, syncReplicaCount) {
  const byName = new Map(settings.map((row) => [row.name, row.setting]));
  const findings = [];
  for (const requirement of REQUIRED_SYNC_DURABILITY) {
    const actual = byName.get(requirement.setting);
    if (actual === undefined) {
      findings.push(`${requirement.setting}: not reported by pg_settings`);
    } else if (!requirement.accepted.includes(actual)) {
      findings.push(`${requirement.setting}=${actual} (required ${requirement.accepted.join('|')}) — ${requirement.reason}`);
    }
  }
  const standbyNames = byName.get('synchronous_standby_names') ?? '';
  if (standbyNames.trim() === '') {
    findings.push('synchronous_standby_names is empty — commits are acknowledged with no synchronous replica');
  }
  if (syncReplicaCount < 1) {
    findings.push(`synchronous replica count is ${syncReplicaCount} — no standby is currently in sync/quorum state`);
  }
  return {
    contract: RPO_CONTRACT_ID,
    syncDurabilityProven: findings.length === 0,
    findings,
    claim: findings.length === 0 ? BACKUP_POINT_SEMANTICS.rpoZeroClaim : BACKUP_POINT_SEMANTICS.dumpAloneClaim,
  };
}

/**
 * Production readiness fails closed when the durability evidence is absent.
 * Task mode records the same findings honestly and stays publishable as a backup point.
 */
export function assertProductionRpoContract(evaluation, mode) {
  if (mode === 'production' && !evaluation.syncDurabilityProven) {
    throw new BlroDurabilityError('BLRO_RPO_SYNC_DURABILITY_UNPROVEN', evaluation.findings.join('; '));
  }
  return evaluation;
}
