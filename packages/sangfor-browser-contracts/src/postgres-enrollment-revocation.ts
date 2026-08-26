import {
  EnrollmentLifecycleAbort,
  inEnrollmentScope,
  readScopedEnrollment,
} from './postgres-enrollment-db.js';
import type { EnrollmentRepositoryContext } from './postgres-enrollment-lifecycle.js';
import type {
  EnrollmentLifecycleDecision,
  RevokeEnrollmentInput,
} from './postgres-enrollment-schemas.js';

const refused = (reason: EnrollmentLifecycleAbort['reason']): EnrollmentLifecycleDecision => ({ ok: false, reason });
export async function revokeScopedEnrollment(
  context: EnrollmentRepositoryContext,
  input: RevokeEnrollmentInput,
): Promise<EnrollmentLifecycleDecision> {
  if (context.scope.tenantId !== input.tenantId || context.scope.projectId !== input.projectId) {
    return refused('BINDING_MISMATCH');
  }
  const now = context.clock.now();
  try {
    return await inEnrollmentScope(context.database, context.scope, async (transaction) => {
      const changed = await transaction.$queryRawUnsafe<readonly { readonly id: string }[]>(
        `UPDATE "BlroEnrollmentIdentity" SET "state"='revoked',"revision"="revision"+1,
          "revokedAt"=$6,"revocationReason"=$7,"revocationRevision"=$5+1,"updatedAt"=$6
         WHERE "tenantId"=$1 AND "projectId"=$2 AND "installationId"=$3 AND "deviceBindingDigest"=$4
           AND "revision"=$5 AND "state"='active' RETURNING "id"`,
        input.tenantId, input.projectId, input.installationId, input.deviceBindingDigest,
        input.expectedRevision, now, input.reason,
      );
      if (!changed[0]) {
        const current = await readScopedEnrollment(transaction, context.scope, input.installationId);
        if (current?.state === 'revoked' && current.revision === input.expectedRevision + 1
          && current.deviceBindingDigest === input.deviceBindingDigest
          && current.revocationReason === input.reason) return { ok: true, enrollment: current };
        throw new EnrollmentLifecycleAbort(current ? 'REVISION_CONFLICT' : 'ENROLLMENT_MISSING');
      }
      await transaction.$executeRawUnsafe(
        `UPDATE "BlroEnrollmentCertificate" SET "state"='revoked',"revokedAt"=$3,
          "revocationReason"=$4,"revision"=$5 WHERE "projectId"=$1 AND "enrollmentId"=$2
          AND "state" IN ('active','overlap')`,
        input.projectId, changed[0].id, now, input.reason, input.expectedRevision + 1,
      );
      const enrollment = await readScopedEnrollment(transaction, context.scope, input.installationId);
      if (!enrollment) throw new EnrollmentLifecycleAbort('ENROLLMENT_MISSING');
      return { ok: true, enrollment };
    });
  } catch (error) {
    if (error instanceof EnrollmentLifecycleAbort) return refused(error.reason);
    throw error;
  }
}
