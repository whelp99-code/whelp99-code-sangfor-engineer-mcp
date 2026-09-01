import { createHash, randomUUID } from 'node:crypto';
import type {
  AcknowledgeRotationInput,
  EnrollmentLifecycleDecision,
  RotateEnrollmentInput,
} from '@sangfor/browser-contracts';
import {
  EnrollmentLifecycleAbort,
  inEnrollmentScope,
  readScopedEnrollment,
  type EnrollmentClock,
  type EnrollmentDatabase,
  type EnrollmentProjectScope,
  type EnrollmentSqlExecutor,
} from './enrollment-database.js';
import type { DerivedClientCertificate, TrustedIssuer } from './enrollment-x509.js';

export const MAX_ROTATION_OVERLAP_MS = 10 * 60_000;

export type EnrollmentRepositoryContext = {
  readonly database: EnrollmentDatabase;
  readonly scope: EnrollmentProjectScope;
  readonly clock: EnrollmentClock;
  readonly trustedIssuers: readonly TrustedIssuer[];
};
type VerifiedRotationInput = Omit<RotateEnrollmentInput, 'certificate'> & {
  readonly certificate: DerivedClientCertificate;
};
const refused = (reason: EnrollmentLifecycleAbort['reason']): EnrollmentLifecycleDecision => ({ ok: false, reason });
const scopeMatches = (
  scope: EnrollmentProjectScope,
  input: { readonly tenantId: string; readonly projectId: string },
): boolean => scope.tenantId === input.tenantId && scope.projectId === input.projectId;
const transitionDigest = (kind: string, values: readonly unknown[]): string => (
  createHash('sha256').update(`sangfor.enrollment-transition.v1\0${kind}\0${JSON.stringify(values)}`).digest('hex')
);

async function complete(
  transaction: EnrollmentSqlExecutor,
  scope: EnrollmentProjectScope,
  installationId: string,
): Promise<EnrollmentLifecycleDecision> {
  const enrollment = await readScopedEnrollment(transaction, scope, installationId);
  if (!enrollment) throw new EnrollmentLifecycleAbort('ENROLLMENT_MISSING');
  return { ok: true, enrollment };
}

function rotationDigest(input: VerifiedRotationInput): string {
  return transitionDigest('rotate', [
    input.tenantId, input.projectId, input.installationId, input.deviceBindingDigest,
    input.expectedRevision, input.overlapExpiresAt, input.certificate,
  ]);
}
function acknowledgementDigest(input: AcknowledgeRotationInput): string {
  return transitionDigest('acknowledge', [
    input.tenantId, input.projectId, input.installationId, input.deviceBindingDigest,
    input.expectedRevision, input.oldSerial, input.newSerial,
  ]);
}

export async function rotateScopedEnrollment(
  context: EnrollmentRepositoryContext,
  input: VerifiedRotationInput,
): Promise<EnrollmentLifecycleDecision> {
  if (!scopeMatches(context.scope, input)) return refused('BINDING_MISMATCH');
  const now = context.clock.now();
  const overlapExpiresAt = Date.parse(input.overlapExpiresAt);
  if (overlapExpiresAt <= now.getTime()
    || overlapExpiresAt > now.getTime() + MAX_ROTATION_OVERLAP_MS
    || overlapExpiresAt > Date.parse(input.certificate.notAfter)) return refused('ROTATION_INVALID');
  const requestDigest = rotationDigest(input);
  try {
    return await inEnrollmentScope(context.database, context.scope, async (transaction) => {
      const locked = await transaction.$queryRawUnsafe<readonly { readonly id: string; readonly oldSerial: string }[]>(
        `SELECT "id","currentCertificateSerial" AS "oldSerial" FROM "BlroEnrollmentIdentity"
         WHERE "tenantId"=$1 AND "projectId"=$2 AND "installationId"=$3
           AND "deviceBindingDigest"=$4 AND "revision"=$5 AND "state"='active'
           AND "currentCertificateSerial"<>$6 FOR UPDATE`,
        input.tenantId, input.projectId, input.installationId, input.deviceBindingDigest,
        input.expectedRevision, input.certificate.serial,
      );
      const changed = locked[0];
      if (!changed) {
        const current = await readScopedEnrollment(transaction, context.scope, input.installationId);
        if (current?.state === 'revoked') throw new EnrollmentLifecycleAbort('ENROLLMENT_REVOKED');
        const prior = await transaction.$queryRawUnsafe<readonly { readonly requestDigest: string }[]>(
          `SELECT r."requestDigest" FROM "BlroEnrollmentRotation" r
           JOIN "BlroEnrollmentIdentity" e ON e."id"=r."enrollmentId" AND e."projectId"=r."projectId"
           WHERE r."projectId"=$1 AND e."installationId"=$2 AND r."newSerial"=$3 AND r."revision"=$4`,
          input.projectId, input.installationId, input.certificate.serial, input.expectedRevision + 1,
        );
        if (current?.revision === input.expectedRevision + 1
          && current.currentCertificateSerial === input.certificate.serial
          && prior[0]?.requestDigest === requestDigest) return { ok: true, enrollment: current };
        throw new EnrollmentLifecycleAbort(current ? 'REVISION_CONFLICT' : 'ENROLLMENT_MISSING');
      }
      await transaction.$executeRawUnsafe(
        `UPDATE "BlroEnrollmentCertificate" SET "state"='superseded',"revision"=$3
         WHERE "projectId"=$1 AND "enrollmentId"=$2 AND "state"='overlap'`,
        input.projectId, changed.id, input.expectedRevision + 1,
      );
      await transaction.$executeRawUnsafe(
        `UPDATE "BlroEnrollmentCertificate" SET "state"='overlap',"overlapExpiresAt"=$4,"revision"=$5
         WHERE "projectId"=$1 AND "enrollmentId"=$2 AND "serial"=$3 AND "state"='active'`,
        input.projectId, changed.id, changed.oldSerial, new Date(input.overlapExpiresAt), input.expectedRevision + 1,
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroEnrollmentCertificate"
         ("id","tenantId","projectId","enrollmentId","issuerChainRef","issuer","subjectAltNames",
          "extendedKeyUsages","serial","fingerprintSha256","notBefore","notAfter","state","revision","createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13,$14)`,
        randomUUID(), input.tenantId, input.projectId, changed.id, input.certificate.issuerChainRef,
        input.certificate.issuer, [...input.certificate.subjectAltNames], [...input.certificate.extendedKeyUsages],
        input.certificate.serial, input.certificate.fingerprintSha256,
        new Date(input.certificate.notBefore), new Date(input.certificate.notAfter), input.expectedRevision + 1, now,
      );
      await transaction.$executeRawUnsafe(
        `UPDATE "BlroEnrollmentIdentity" SET "revision"="revision"+1,
          "currentCertificateSerial"=$3,"updatedAt"=$4 WHERE "projectId"=$1 AND "id"=$2`,
        input.projectId, changed.id, input.certificate.serial, now,
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroEnrollmentRotation"
         ("id","tenantId","projectId","enrollmentId","oldSerial","newSerial","overlapExpiresAt",
          "requestDigest","revision","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        randomUUID(), input.tenantId, input.projectId, changed.id, changed.oldSerial,
        input.certificate.serial, new Date(input.overlapExpiresAt), requestDigest, input.expectedRevision + 1, now,
      );
      return complete(transaction, context.scope, input.installationId);
    });
  } catch (error) {
    if (error instanceof EnrollmentLifecycleAbort) return refused(error.reason);
    throw error;
  }
}

export async function acknowledgeScopedRotation(
  context: EnrollmentRepositoryContext,
  input: AcknowledgeRotationInput,
): Promise<EnrollmentLifecycleDecision> {
  if (!scopeMatches(context.scope, input)) return refused('BINDING_MISMATCH');
  const now = context.clock.now();
  const requestDigest = acknowledgementDigest(input);
  try {
    return await inEnrollmentScope(context.database, context.scope, async (transaction) => {
      const enrollment = await transaction.$queryRawUnsafe<readonly { readonly id: string }[]>(
        `SELECT "id" FROM "BlroEnrollmentIdentity" WHERE "tenantId"=$1 AND "projectId"=$2
         AND "installationId"=$3 AND "deviceBindingDigest"=$4 AND "revision"=$5
         AND "state"='active' AND "currentCertificateSerial"=$6 FOR UPDATE`,
        input.tenantId, input.projectId, input.installationId, input.deviceBindingDigest,
        input.expectedRevision, input.newSerial,
      );
      if (!enrollment[0]) {
        const current = await readScopedEnrollment(transaction, context.scope, input.installationId);
        if (current?.state === 'revoked') throw new EnrollmentLifecycleAbort('ENROLLMENT_REVOKED');
        const prior = await transaction.$queryRawUnsafe<readonly { readonly acknowledgementDigest: string | null }[]>(
          `SELECT r."acknowledgementDigest" FROM "BlroEnrollmentRotation" r
           JOIN "BlroEnrollmentIdentity" e ON e."id"=r."enrollmentId" AND e."projectId"=r."projectId"
           WHERE r."projectId"=$1 AND e."installationId"=$2 AND r."oldSerial"=$3
             AND r."newSerial"=$4 AND r."revision"=$5`,
          input.projectId, input.installationId, input.oldSerial, input.newSerial, input.expectedRevision,
        );
        if (current?.revision === input.expectedRevision + 1
          && prior[0]?.acknowledgementDigest === requestDigest) return { ok: true, enrollment: current };
        throw new EnrollmentLifecycleAbort(current ? 'REVISION_CONFLICT' : 'ENROLLMENT_MISSING');
      }
      const rotations = await transaction.$queryRawUnsafe<readonly { readonly id: string }[]>(
        `UPDATE "BlroEnrollmentRotation" SET "acknowledgedAt"=$6,"acknowledgementDigest"=$7
         WHERE "projectId"=$1 AND "enrollmentId"=$2 AND "oldSerial"=$3 AND "newSerial"=$4
           AND "revision"=$5 AND "acknowledgedAt" IS NULL RETURNING "id"`,
        input.projectId, enrollment[0].id, input.oldSerial, input.newSerial,
        input.expectedRevision, now, requestDigest,
      );
      if (!rotations[0]) throw new EnrollmentLifecycleAbort('ROTATION_INVALID');
      await transaction.$executeRawUnsafe(
        `UPDATE "BlroEnrollmentCertificate" SET "state"='superseded',"acknowledgedAt"=$4,"revision"=$5
         WHERE "projectId"=$1 AND "enrollmentId"=$2 AND "serial"=$3 AND "state"='overlap'`,
        input.projectId, enrollment[0].id, input.oldSerial, now, input.expectedRevision + 1,
      );
      await transaction.$executeRawUnsafe(
        `UPDATE "BlroEnrollmentIdentity" SET "revision"="revision"+1,"updatedAt"=$3
         WHERE "projectId"=$1 AND "id"=$2`, input.projectId, enrollment[0].id, now,
      );
      return complete(transaction, context.scope, input.installationId);
    });
  } catch (error) {
    if (error instanceof EnrollmentLifecycleAbort) return refused(error.reason);
    throw error;
  }
}
