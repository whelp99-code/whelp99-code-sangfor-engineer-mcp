// Recovery policy, applied ONLY inside a verified scratch target.
//
// The policy exists because a restored authority store is, by construction, stale: every approval
// and nonce it contains was minted before the recovery point and may already have been spent
// against the lost primary. So the policy spends them all and bumps the project epoch, which makes
// every previously signed approval / nonce / capability JTI refuse on replay.
//
// What the policy must NEVER do: reset, delete, or promote uncertainty. A remote job in
// `indeterminate` stays `indeterminate` — a human verifies the device. Completed jobs and their
// result digests are preserved byte-exact.
import { createHmac } from 'node:crypto';
import { canonicalJson } from './blro-backup-manifest.mjs';

export const RECOVERY_AUDIT_KIND = 'blro.recovery.policy.applied';
/**
 * Uncertainty the policy must never touch. `indeterminate` is the load-bearing one: a device may
 * have changed without proof, and only a human read-back may resolve it.
 */
export const UNCERTAIN_JOB_STATE = 'indeterminate';

export class BlroRecoveryPolicyError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'BlroRecoveryPolicyError';
    this.code = code;
  }
}

/**
 * Pre-policy equality gate. The policy is a mutation, so it may only run against a target already
 * proven byte-equal to the backup; otherwise it would mask a bad restore with a fresh epoch.
 */
export function assertPrePolicyEquality(problems) {
  if (problems.length > 0) {
    throw new BlroRecoveryPolicyError('BLRO_DRILL_PRE_POLICY_EQUALITY_FAILED', problems.join('; '));
  }
}

function auditDigest(event, secret) {
  return createHmac('sha256', secret).update(canonicalJson({
    actorId: event.actorId ?? null,
    at: event.at,
    kind: event.kind,
    payload: event.payload,
    prevHash: event.prevHash,
    projectId: event.projectId,
    seq: event.seq,
  }), 'utf8').digest('hex');
}

/**
 * Apply the recovery policy atomically per project.
 *
 * Every step is inside one serializable transaction: an interrupted policy leaves the scratch
 * target with its old epoch and unspent authority, which is a re-runnable state, not a torn one.
 */
export async function applyRecoveryPolicy(sql, options) {
  const applied = [];
  for (const projectId of options.projectIds) {
    applied.push(await sql.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);

      const before = await readAuthoritySnapshot(tx, projectId);
      const epochRows = await tx.$queryRawUnsafe(
        `UPDATE "BlroProjectAuthorityEpoch" SET "epoch"="epoch"+1, "revision"="revision"+1 WHERE "projectId"=$1 RETURNING "epoch","revision"`,
        projectId,
      );
      const epoch = epochRows[0];
      if (!epoch) throw new BlroRecoveryPolicyError('BLRO_RECOVERY_EPOCH_MISSING', projectId);

      // Spend, never delete: the record that an approval existed is itself audit evidence.
      const spentApprovals = await tx.$executeRawUnsafe(
        `UPDATE "BlroApproval" SET "status"='spent' WHERE "projectId"=$1 AND "status" <> 'spent'`, projectId,
      );
      const spentNonces = await tx.$executeRawUnsafe(
        `UPDATE "BlroApprovalNonce" SET "consumedAt"=now() WHERE "projectId"=$1 AND "consumedAt" IS NULL`, projectId,
      );

      const after = await readAuthoritySnapshot(tx, projectId);
      assertJobsPreserved(before.jobs, after.jobs);
      if (after.outstandingApprovals !== 0 || after.outstandingNonces !== 0) {
        throw new BlroRecoveryPolicyError('BLRO_RECOVERY_AUTHORITY_STILL_OUTSTANDING', projectId);
      }

      const head = await tx.$queryRawUnsafe(
        `SELECT "seq"::text AS seq, "hash" FROM "BlroAuditEvent" WHERE "projectId"=$1 ORDER BY "seq" DESC LIMIT 1`, projectId,
      );
      const event = {
        projectId,
        seq: head[0] === undefined ? 0 : Number(head[0].seq) + 1,
        kind: RECOVERY_AUDIT_KIND,
        at: options.at,
        actorId: options.actorId,
        prevHash: head[0]?.hash ?? 'GENESIS',
        payload: {
          backupId: options.backupId,
          recoveryPointLsn: options.recoveryPointLsn,
          epoch: epoch.epoch,
          spentApprovals,
          spentNonces,
          preservedIndeterminate: before.jobs.filter((job) => job.state === 'indeterminate').length,
          preservedCompleted: before.jobs.filter((job) => job.state === 'result_committed').length,
        },
      };
      const hash = auditDigest(event, options.auditSecret);
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroAuditEvent" ("id","tenantId","projectId","seq","at","actorId","kind","payload","prevHash","hash","keyed") VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8::jsonb,$9,$10,true)`,
        `recovery-${options.backupId}-${projectId}`, options.tenantId, projectId, event.seq, event.at,
        options.actorId, event.kind, JSON.stringify(event.payload), event.prevHash, hash,
      );
      return {
        projectId,
        epoch: epoch.epoch,
        revision: epoch.revision,
        spentApprovals,
        spentNonces,
        auditSeq: event.seq,
        auditHash: hash,
        preservedJobs: before.jobs.length,
      };
    }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 120_000 }));
  }
  return applied;
}

async function readAuthoritySnapshot(tx, projectId) {
  const jobs = await tx.$queryRawUnsafe(
    `SELECT "id","state","resultDigest","capabilityJti","tombstoneCommittedAt"::text AS "tombstoneCommittedAt","indeterminateAt"::text AS "indeterminateAt" FROM "BlroRemoteJob" WHERE "projectId"=$1 ORDER BY "id"`,
    projectId,
  );
  const approvals = await tx.$queryRawUnsafe(
    `SELECT count(*)::int AS count FROM "BlroApproval" WHERE "projectId"=$1 AND "status" <> 'spent'`, projectId,
  );
  const nonces = await tx.$queryRawUnsafe(
    `SELECT count(*)::int AS count FROM "BlroApprovalNonce" WHERE "projectId"=$1 AND "consumedAt" IS NULL`, projectId,
  );
  return { jobs, outstandingApprovals: approvals[0]?.count ?? 0, outstandingNonces: nonces[0]?.count ?? 0 };
}

/**
 * Tombstones and results are preserved exactly. Two distinct checks, because they fail differently:
 * whole-set inequality catches any mutation at all, and the uncertainty check names the specific
 * forbidden transition (INDETERMINATE deleted, or promoted to a terminal result) explicitly.
 */
export function assertJobsPreserved(before, after) {
  const uncertain = before.filter((job) => job.state === UNCERTAIN_JOB_STATE);
  const lost = uncertain.filter((job) => !after.some((candidate) => candidate.id === job.id
    && candidate.state === UNCERTAIN_JOB_STATE));
  if (lost.length > 0) {
    throw new BlroRecoveryPolicyError('BLRO_RECOVERY_UNCERTAINTY_CONVERTED', lost.map((job) => job.id).join(', '));
  }
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new BlroRecoveryPolicyError('BLRO_RECOVERY_JOB_TOMBSTONE_MUTATED');
  }
  return before.length;
}

/**
 * Prove the replay refusal the policy claims: an approval, nonce and capability JTI carried over
 * from before the recovery point must all be refused now. This is a read-back of the policy's
 * effect, not a restatement of its intent.
 */
export async function proveReplayRefused(sql, projectId, replay) {
  await sql.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,false)`, projectId);
  const [epoch] = await sql.$queryRawUnsafe(
    `SELECT "epoch" FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$1`, projectId,
  );
  const refusals = [];
  if (epoch === undefined) throw new BlroRecoveryPolicyError('BLRO_RECOVERY_EPOCH_MISSING', projectId);
  if (replay.signedEpoch >= epoch.epoch) {
    throw new BlroRecoveryPolicyError('BLRO_RECOVERY_EPOCH_NOT_ADVANCED', `${replay.signedEpoch} >= ${epoch.epoch}`);
  }
  refusals.push({ kind: 'epoch', reason: 'AUTHORITY_EPOCH_STALE', signed: replay.signedEpoch, current: epoch.epoch });

  const [approval] = await sql.$queryRawUnsafe(
    `SELECT "status","authorityEpoch" FROM "BlroApproval" WHERE "id"=$1`, replay.approvalId,
  );
  if (approval?.status !== 'spent') throw new BlroRecoveryPolicyError('BLRO_RECOVERY_APPROVAL_REPLAYABLE', replay.approvalId);
  refusals.push({ kind: 'approval', reason: 'APPROVAL_ALREADY_SPENT', id: replay.approvalId });

  const [nonce] = await sql.$queryRawUnsafe(
    `SELECT "consumedAt" IS NOT NULL AS consumed FROM "BlroApprovalNonce" WHERE "id"=$1`, replay.nonceId,
  );
  if (nonce?.consumed !== true) throw new BlroRecoveryPolicyError('BLRO_RECOVERY_NONCE_REPLAYABLE', replay.nonceId);
  refusals.push({ kind: 'nonce', reason: 'NONCE_ALREADY_USED', id: replay.nonceId });

  const [jti] = await sql.$queryRawUnsafe(
    `SELECT "consumedAt" IS NOT NULL AS consumed FROM "BlroRemoteJobCapabilityJti" WHERE "jti"=$1`, replay.capabilityJti,
  );
  if (jti === undefined) throw new BlroRecoveryPolicyError('BLRO_RECOVERY_JTI_MISSING', replay.capabilityJti);
  refusals.push({ kind: 'capabilityJti', reason: 'JTI_TOMBSTONED', id: replay.capabilityJti, consumed: jti.consumed });
  return refusals;
}
