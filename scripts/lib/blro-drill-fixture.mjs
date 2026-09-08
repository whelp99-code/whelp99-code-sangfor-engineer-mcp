// Authority fixture for the BLRO restore drill.
//
// The drill only proves something if the source carries the state it claims to protect: a keyed
// audit chain, an authority epoch, outstanding (unspent) approvals and nonces, an evidence manifest
// that references a real object on disk, and remote-job tombstones including an INDETERMINATE one
// that the recovery policy must preserve untouched.
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from './blro-backup-manifest.mjs';

const digest = (label) => createHash('sha256').update(label, 'utf8').digest('hex');

function auditHash(event, secret) {
  return createHmac('sha256', secret).update(canonicalJson({
    actorId: event.actorId ?? null, at: event.at, kind: event.kind, payload: event.payload,
    prevHash: event.prevHash, projectId: event.projectId, seq: event.seq,
  }), 'utf8').digest('hex');
}

/**
 * Seed one complete authority project. Returns the identifiers the drill and its assertions need.
 * @param {{ $executeRawUnsafe: Function, $transaction: Function }} sql
 */
export async function seedDrillFixture(sql, options) {
  const { suffix, auditSecret, evidenceRoot } = options;
  const ids = {
    tenantId: `drill-tenant-${suffix}`,
    projectId: `drill-project-${suffix}`,
    actorId: `drill-actor-${suffix}`,
    roleId: `drill-role-${suffix}`,
    approvalId: `drill-approval-${suffix}`,
    nonceId: `drill-nonce-${suffix}`,
    runId: `drill-run-${suffix}`,
    stepId: `drill-step-${suffix}`,
    evidenceId: `drill-evidence-${suffix}`,
    installationId: `drill-install-${suffix}`,
    enrollmentId: `drill-enrollment-${suffix}`,
    completedJobId: `drill-job-done-${suffix}`,
    indeterminateJobId: `drill-job-indeterminate-${suffix}`,
    capabilityJti: `drill-jti-${suffix}`,
    indeterminateJti: `drill-jti-indeterminate-${suffix}`,
    epoch: 7,
  };
  const objectRelativePath = join('drill', suffix, 'observation.json');
  const objectPath = join(evidenceRoot, objectRelativePath);
  mkdirSync(dirname(objectPath), { recursive: true });
  const objectBytes = Buffer.from(`${canonicalJson({ observation: suffix, verdict: 'PASS' })}\n`, 'utf8');
  writeFileSync(objectPath, objectBytes);
  ids.evidenceObjectPath = objectRelativePath;
  ids.evidenceObjectHash = createHash('sha256').update(objectRelativePath, 'utf8').update(objectBytes).digest('hex');

  await sql.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2)`, ids.tenantId, `drill ${suffix}`);
  await sql.$executeRawUnsafe(`INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,$3,'service')`, ids.actorId, ids.tenantId, `drill ${suffix}`);
  await sql.$executeRawUnsafe(`INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ($1,$2,$3,ARRAY['drill:write'])`, ids.roleId, ids.tenantId, `drill-${suffix}`);

  await sql.$transaction(async (tx) => {
    const run = async (statement, ...values) => { await tx.$executeRawUnsafe(statement, ...values); };
    await run(`SELECT set_config('app.project_id',$1,true)`, ids.projectId);
    await run(`INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`, ids.projectId, ids.tenantId, `drill ${suffix}`);
    await run(`INSERT INTO "BlroMembership" ("id","tenantId","projectId","actorId","roleId") VALUES ($1,$2,$3,$4,$5)`, `drill-membership-${suffix}`, ids.tenantId, ids.projectId, ids.actorId, ids.roleId);
    await run(`INSERT INTO "BlroProjectAuthorityEpoch" ("projectId","epoch","revision") VALUES ($1,$2,0)`, ids.projectId, ids.epoch);
    // POSTGRES_PRIMARY carries a fence timestamp by check constraint; the fixture honours it.
    await run(`INSERT INTO "BlroAuthorityCutover" ("projectId","aggregate","state","epoch","revision","localWriteFencedAt") VALUES ($1,'evals','POSTGRES_PRIMARY',$2,0,now())`, ids.projectId, ids.epoch);
    // Audit stays rollbackable so this disposable fixture's own `legacy.*` rows can be torn down.
    // Ordinary audit kinds are physically append-only and the fixture never tries to remove them.
    await run(`INSERT INTO "BlroAuthorityCutover" ("projectId","aggregate","state","epoch","revision") VALUES ($1,'audit','SHADOW_READING',$2,0)`, ids.projectId, ids.epoch);

    // Outstanding authority: an unspent approval and an unconsumed nonce, both from the old epoch.
    await run(`INSERT INTO "BlroApproval" ("id","tenantId","projectId","actorId","actionHash","expiresAt","status","authorityEpoch") VALUES ($1,$2,$3,$4,$5,now()+interval '1 hour','approved',$6)`, ids.approvalId, ids.tenantId, ids.projectId, ids.actorId, digest(`action-${suffix}`), ids.epoch);
    await run(`INSERT INTO "BlroApprovalNonce" ("id","tenantId","projectId","nonce","expiresAt","authorityEpoch") VALUES ($1,$2,$3,$4,now()+interval '1 hour',$5)`, ids.nonceId, ids.tenantId, ids.projectId, `drill-nonce-value-${suffix}`, ids.epoch);

    await run(`INSERT INTO "BlroRun" ("id","tenantId","projectId","actorId","status","toolProfileVersion","sourceSystem","authorityEpoch") VALUES ($1,$2,$3,$4,'created','drill-v1','drill',$5)`, ids.runId, ids.tenantId, ids.projectId, ids.actorId, ids.epoch);
    await run(`INSERT INTO "BlroRunStep" ("id","tenantId","projectId","runId","actorId","ordinal","status","payload") VALUES ($1,$2,$3,$4,$5,0,'created','{}')`, ids.stepId, ids.tenantId, ids.projectId, ids.runId, ids.actorId);
    await run(`INSERT INTO "BlroEvidenceManifest" ("id","tenantId","projectId","actorId","runId","contentHash","manifest") VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, ids.evidenceId, ids.tenantId, ids.projectId, ids.actorId, ids.runId, digest(`evidence-${suffix}`), JSON.stringify({ objects: [{ objectPath: objectRelativePath }] }));

    await run(`INSERT INTO "BlroEnrollmentIdentity" ("id","tenantId","projectId","installationId","deviceBindingDigest","clientIdentityId","state","revision","currentCertificateSerial","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'active',1,$7,now(),now())`, ids.enrollmentId, ids.tenantId, ids.projectId, ids.installationId, digest(`device-${suffix}`), `drill-client-${suffix}`, `drill-serial-${suffix}`);

    // Two tombstones: one completed with a result digest, one INDETERMINATE that must survive.
    for (const job of [
      { id: ids.completedJobId, jti: ids.capabilityJti, state: 'result_retained', resultDigest: digest(`result-${suffix}`) },
      { id: ids.indeterminateJobId, jti: ids.indeterminateJti, state: 'indeterminate', resultDigest: null },
    ]) {
      const requestDigest = digest(`request-${job.id}`);
      await run(`INSERT INTO "BlroRemoteJobCapabilityJti" ("jti","tenantId","projectId","installationId","jobId","requestDigest","capabilityExpiresAt","consumedAt") VALUES ($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now())`, job.jti, ids.tenantId, ids.projectId, ids.installationId, job.id, requestDigest);
      await run(`INSERT INTO "BlroRemoteJob" ("id","tenantId","projectId","installationId","jobId","runId","stepId","requestId","requestDigest","capabilityJti","state","authorityEpoch","result","resultDigest","tombstoneCommittedAt","resultCommittedAt","indeterminateAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,now(),${job.resultDigest ? 'now()' : 'NULL'},${job.resultDigest ? 'NULL' : 'now()'},now(),now())`,
        job.id, ids.tenantId, ids.projectId, ids.installationId, job.id, ids.runId, ids.stepId,
        `drill-request-${job.id}`, requestDigest, job.jti, job.state, ids.epoch,
        job.resultDigest ? JSON.stringify({ verdict: 'PASS' }) : null, job.resultDigest);
    }

    // Keyed audit chain: three events, contiguous seq, HMAC-linked.
    let prevHash = 'GENESIS';
    for (let seq = 0; seq < 3; seq += 1) {
      const event = {
        projectId: ids.projectId, seq, kind: `legacy.drill.event.${seq}`, payload: { seq },
        prevHash, at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), actorId: ids.actorId,
      };
      const hash = auditHash(event, auditSecret);
      await run(`INSERT INTO "BlroAuditEvent" ("id","tenantId","projectId","seq","at","actorId","kind","payload","prevHash","hash","keyed") VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8::jsonb,$9,$10,true)`,
        `drill-audit-${suffix}-${seq}`, ids.tenantId, ids.projectId, seq, event.at, ids.actorId,
        event.kind, JSON.stringify(event.payload), prevHash, hash);
      prevHash = hash;
    }
    ids.auditHeadHash = prevHash;
  }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 120_000 });

  return ids;
}

/** Remove exactly the rows this fixture created, leaving any other project untouched. */
export async function dropDrillFixture(sql, ids) {
  await sql.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, ids.projectId);
    for (const table of [
      'BlroAuditEvent', 'BlroRemoteJob', 'BlroRemoteJobCapabilityJti', 'BlroEnrollmentIdentity',
      'BlroEvidenceManifest', 'BlroRunStep', 'BlroRun', 'BlroApprovalNonce', 'BlroApproval',
      'BlroAuthorityCutover', 'BlroProjectAuthorityEpoch', 'BlroMembership', 'BlroProject',
    ]) {
      const column = table === 'BlroProject' ? 'id' : 'projectId';
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${column}"=$1`, ids.projectId);
    }
  }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 120_000 });
  await sql.$executeRawUnsafe(`DELETE FROM "BlroRole" WHERE "id"=$1`, ids.roleId);
  await sql.$executeRawUnsafe(`DELETE FROM "BlroActor" WHERE "id"=$1`, ids.actorId);
  await sql.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, ids.tenantId);
}
