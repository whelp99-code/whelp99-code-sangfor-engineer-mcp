import type { PrismaClient } from '@prisma/client';
import type { AuthorityConfig, AuthorityConfigField } from './authority-config.js';

export const BLRO_RUNTIME_SCHEMA_VERSION = '20260826170000_blro_runtime_stores' as const;

export type AuthorityReadinessReasonCode =
  | 'CONFIG_INVALID'
  | 'DATABASE_UNAVAILABLE'
  | 'SCHEMA_INVALID'
  | 'SIGNING_INVALID'
  | 'TRUST_INVALID'
  | 'SCOPE_INVALID'
  | 'DOMAIN_APIS_INVALID'
  | 'DRAINING';
export type AuthorityReadinessReason = {
  readonly code: AuthorityReadinessReasonCode;
  readonly fields?: readonly AuthorityConfigField[];
};
export type AuthorityCheck = {
  readonly ok: boolean;
  readonly reason?: AuthorityReadinessReason;
};
export type AuthorityDependencyChecks = {
  readonly config: AuthorityCheck;
  readonly database: AuthorityCheck;
  readonly schema: AuthorityCheck;
  readonly signing: AuthorityCheck;
  readonly trust: AuthorityCheck;
  readonly scope: AuthorityCheck;
  readonly domainApis: AuthorityCheck;
  readonly drain: AuthorityCheck;
};
export type AuthorityReadiness = {
  readonly ok: boolean;
  readonly schemaVersion: string;
  readonly checks: AuthorityDependencyChecks;
};
export function firstReadinessFailure(readiness: AuthorityReadiness): AuthorityReadinessReasonCode {
  for (const check of Object.values(readiness.checks)) {
    if (!check.ok && check.reason) return check.reason.code;
  }
  return 'DATABASE_UNAVAILABLE';
}

export type AuthorityProbeResult = {
  readonly database: boolean;
  readonly schema: boolean;
  readonly scope: boolean;
};

const SCOPED_AUTHORITY_TABLES = [
  'BlroProject', 'BlroApprovalNonce', 'BlroAuditEvent', 'BlroMembership', 'BlroDevice',
  'BlroRun', 'BlroRunStep', 'BlroApproval', 'BlroEvidenceManifest', 'BlroRagDocument',
  'BlroRagChunk', 'BlroClientEnrollment', 'BlroBrowserJobResult',
] as const;

export async function probeAuthorityDependencies(
  prisma: PrismaClient,
  config: AuthorityConfig,
  probeOverride?: () => Promise<boolean>,
): Promise<AuthorityProbeResult> {
  if (probeOverride && !await probeOverride()) {
    return { database: false, schema: false, scope: false };
  }
  await prisma.$queryRawUnsafe(`SELECT 1`);
  try {
    const schema = await prisma.$queryRawUnsafe<readonly { readonly version: string }[]>(
      `SELECT "version" FROM "BlroRuntimeSchema" WHERE "component"='control-tower-authority'`,
    );
    const tables = await prisma.$queryRawUnsafe<readonly { readonly count: number }[]>(
      `SELECT COUNT(*)::int AS "count" FROM pg_class
       WHERE relname = ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity`,
      SCOPED_AUTHORITY_TABLES,
    );
    if (schema[0]?.version !== BLRO_RUNTIME_SCHEMA_VERSION || tables[0]?.count !== SCOPED_AUTHORITY_TABLES.length) {
      return { database: true, schema: false, scope: false };
    }
  } catch {
    return { database: true, schema: false, scope: false };
  }
  try {
    const project = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, config.projectId);
      return transaction.$queryRawUnsafe<readonly { readonly tenantId: string }[]>(
        `SELECT "tenantId" FROM "BlroProject" WHERE "id"=$1`, config.projectId,
      );
    });
    return { database: true, schema: true, scope: project[0]?.tenantId === config.tenantId };
  } catch {
    return { database: true, schema: true, scope: false };
  }
}
