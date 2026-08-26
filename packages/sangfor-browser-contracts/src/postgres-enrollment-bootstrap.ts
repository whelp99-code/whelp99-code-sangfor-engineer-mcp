import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  EnrollmentLifecycleAbort,
  inEnrollmentScope,
  readScopedEnrollment,
  type EnrollmentSqlExecutor,
} from './postgres-enrollment-db.js';
import type { EnrollmentRepositoryContext } from './postgres-enrollment-lifecycle.js';
import {
  MAX_BOOTSTRAP_TTL_MS,
  enrollmentGrantSchema,
  type ClaimBootstrapTokenInput,
  type EnrollmentLifecycleDecision,
  type EnrollmentLifecycleRefusal,
  type IssueBootstrapTokenInput,
} from './postgres-enrollment-schemas.js';
import type { DerivedClientCertificate } from './postgres-enrollment-x509.js';

export type BootstrapTokenDecision =
  | { readonly ok: true; readonly tokenDigest: string }
  | { readonly ok: false; readonly reason: EnrollmentLifecycleRefusal };
const refused = (reason: EnrollmentLifecycleRefusal): EnrollmentLifecycleDecision => ({ ok: false, reason });
const bindingMatches = (
  context: EnrollmentRepositoryContext,
  input: { readonly tenantId: string; readonly projectId: string },
): boolean => input.tenantId === context.scope.tenantId && input.projectId === context.scope.projectId;

export async function issueScopedBootstrapToken(
  context: EnrollmentRepositoryContext,
  parsed: IssueBootstrapTokenInput,
): Promise<BootstrapTokenDecision> {
  if (!bindingMatches(context, parsed)) return { ok: false, reason: 'BINDING_MISMATCH' };
  const now = context.clock.now();
  const expiresAt = Date.parse(parsed.expiresAt);
  if (expiresAt <= now.getTime()) return { ok: false, reason: 'TOKEN_EXPIRED' };
  if (expiresAt > now.getTime() + MAX_BOOTSTRAP_TTL_MS) {
    return { ok: false, reason: 'TOKEN_TTL_EXCEEDED' };
  }
  return inEnrollmentScope(context.database, context.scope, async (transaction) => {
    const inserted = await transaction.$queryRawUnsafe<readonly { readonly tokenDigest: string }[]>(
      `INSERT INTO "BlroEnrollmentBootstrapToken"
       ("id","tenantId","projectId","installationId","deviceBindingDigest","tokenDigest",
        "grants","expiresAt","revision","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,0,$9)
       ON CONFLICT ("projectId","tokenDigest") DO NOTHING RETURNING "tokenDigest"`,
      randomUUID(), parsed.tenantId, parsed.projectId, parsed.installationId,
      parsed.deviceBindingDigest, parsed.tokenDigest, JSON.stringify(parsed.grants),
      new Date(parsed.expiresAt), now,
    );
    if (inserted[0]) return { ok: true, tokenDigest: parsed.tokenDigest };
    const existing = await transaction.$queryRawUnsafe<readonly {
      readonly installationId: string; readonly deviceBindingDigest: string;
      readonly expiresAt: Date; readonly grants: unknown;
    }[]>(
      `SELECT "installationId","deviceBindingDigest","expiresAt","grants"
       FROM "BlroEnrollmentBootstrapToken" WHERE "projectId"=$1 AND "tokenDigest"=$2`,
      parsed.projectId, parsed.tokenDigest,
    );
    const row = existing[0];
    const grants = z.array(enrollmentGrantSchema).parse(row?.grants ?? []);
    const same = row?.installationId === parsed.installationId
      && row.deviceBindingDigest === parsed.deviceBindingDigest
      && row.expiresAt.toISOString() === parsed.expiresAt
      && JSON.stringify(grants) === JSON.stringify(parsed.grants);
    return same ? { ok: true, tokenDigest: parsed.tokenDigest } : { ok: false, reason: 'TOKEN_INVALID' };
  });
}

async function complete(
  transaction: EnrollmentSqlExecutor,
  context: EnrollmentRepositoryContext,
  installationId: string,
): Promise<EnrollmentLifecycleDecision> {
  const enrollment = await readScopedEnrollment(transaction, context.scope, installationId);
  if (!enrollment) throw new EnrollmentLifecycleAbort('ENROLLMENT_MISSING');
  return { ok: true, enrollment };
}

export async function claimScopedBootstrapToken(
  context: EnrollmentRepositoryContext,
  parsed: ClaimBootstrapTokenInput,
  certificate: DerivedClientCertificate,
): Promise<EnrollmentLifecycleDecision> {
  if (!bindingMatches(context, parsed)) return refused('BINDING_MISMATCH');
  const now = context.clock.now();
  try {
    return await inEnrollmentScope(context.database, context.scope, async (transaction) => {
      const tokens = await transaction.$queryRawUnsafe<readonly { readonly grants: unknown }[]>(
        `UPDATE "BlroEnrollmentBootstrapToken" SET "claimedAt"=$6,"revision"=1
         WHERE "tenantId"=$1 AND "projectId"=$2 AND "installationId"=$3
           AND "deviceBindingDigest"=$4 AND "tokenDigest"=$5 AND "claimedAt" IS NULL
           AND "expiresAt">$6 RETURNING "grants"`,
        parsed.tenantId, parsed.projectId, parsed.installationId,
        parsed.deviceBindingDigest, parsed.tokenDigest, now,
      );
      const token = tokens[0];
      if (!token) {
        const states = await transaction.$queryRawUnsafe<readonly {
          readonly claimedAt: Date | null; readonly expiresAt: Date;
        }[]>(
          `SELECT "claimedAt","expiresAt" FROM "BlroEnrollmentBootstrapToken"
           WHERE "projectId"=$1 AND "tokenDigest"=$2`, parsed.projectId, parsed.tokenDigest,
        );
        const state = states[0];
        if (!state) throw new EnrollmentLifecycleAbort('TOKEN_INVALID');
        if (state.claimedAt) throw new EnrollmentLifecycleAbort('TOKEN_REPLAYED');
        if (state.expiresAt.getTime() <= now.getTime()) throw new EnrollmentLifecycleAbort('TOKEN_EXPIRED');
        throw new EnrollmentLifecycleAbort('BINDING_MISMATCH');
      }
      const enrollmentId = randomUUID();
      const identities = await transaction.$queryRawUnsafe<readonly { readonly id: string }[]>(
        `INSERT INTO "BlroEnrollmentIdentity"
         ("id","tenantId","projectId","installationId","deviceBindingDigest","clientIdentityId",
          "state","revision","currentCertificateSerial","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'active',1,$7,$8,$8)
         ON CONFLICT ("projectId","installationId") DO NOTHING RETURNING "id"`,
        enrollmentId, parsed.tenantId, parsed.projectId, parsed.installationId,
        parsed.deviceBindingDigest, parsed.clientIdentityId, certificate.serial, now,
      );
      if (!identities[0]) throw new EnrollmentLifecycleAbort('ENROLLMENT_EXISTS');
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroEnrollmentCertificate"
         ("id","tenantId","projectId","enrollmentId","issuerChainRef","issuer","subjectAltNames",
          "extendedKeyUsages","serial","fingerprintSha256","notBefore","notAfter","state","revision","createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',1,$13)`,
        randomUUID(), parsed.tenantId, parsed.projectId, enrollmentId,
        certificate.issuerChainRef, certificate.issuer, [...certificate.subjectAltNames],
        [...certificate.extendedKeyUsages], certificate.serial, certificate.fingerprintSha256,
        new Date(certificate.notBefore), new Date(certificate.notAfter), now,
      );
      const grants = z.array(enrollmentGrantSchema).parse(token.grants);
      for (const grant of grants) {
        await transaction.$executeRawUnsafe(
          `INSERT INTO "BlroEnrollmentGrant"
           ("id","tenantId","projectId","enrollmentId","originDigest","scope","revision","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,1,$7)`,
          randomUUID(), parsed.tenantId, parsed.projectId, enrollmentId,
          grant.originDigest, grant.scope, now,
        );
      }
      return complete(transaction, context, parsed.installationId);
    });
  } catch (error) {
    if (error instanceof EnrollmentLifecycleAbort) return refused(error.reason);
    throw error;
  }
}
