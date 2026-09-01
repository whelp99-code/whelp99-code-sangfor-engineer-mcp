import {
  persistedScopedEnrollmentSchema,
  type EnrollmentLifecycleRefusal,
  type PersistedScopedEnrollment,
} from '@sangfor/browser-contracts';

export interface EnrollmentSqlExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown[]>(query: string, ...values: unknown[]): Promise<T>;
}
export interface EnrollmentDatabase extends EnrollmentSqlExecutor {
  $transaction<T>(
    work: (transaction: EnrollmentSqlExecutor) => Promise<T>,
    options?: { readonly isolationLevel?: 'Serializable' },
  ): Promise<T>;
}
export type EnrollmentProjectScope = {
  readonly tenantId: string;
  readonly projectId: string;
};
export type EnrollmentClock = { readonly now: () => Date };

export async function inEnrollmentScope<T>(
  database: EnrollmentDatabase,
  scope: EnrollmentProjectScope,
  work: (transaction: EnrollmentSqlExecutor) => Promise<T>,
): Promise<T> {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, scope.projectId);
    return work(transaction);
  });
}

type EnrollmentRow = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly deviceBindingDigest: string;
  readonly clientIdentityId: string;
  readonly state: string;
  readonly revision: number;
  readonly currentCertificateSerial: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
  readonly revocationRevision: number | null;
  readonly grants: unknown;
};

export async function readScopedEnrollment(
  transaction: EnrollmentSqlExecutor,
  scope: EnrollmentProjectScope,
  installationId: string,
): Promise<PersistedScopedEnrollment | undefined> {
  const rows = await transaction.$queryRawUnsafe<readonly EnrollmentRow[]>(
    `SELECT e."tenantId",e."projectId",e."installationId",e."deviceBindingDigest",
      e."clientIdentityId",e."state",e."revision",e."currentCertificateSerial",
      e."createdAt",e."updatedAt",e."revokedAt",e."revocationReason",e."revocationRevision",
      COALESCE(jsonb_agg(jsonb_build_object('originDigest',g."originDigest",'scope',g."scope")
        ORDER BY g."originDigest",g."scope") FILTER (WHERE g."id" IS NOT NULL),'[]'::jsonb) AS grants
     FROM "BlroEnrollmentIdentity" e LEFT JOIN "BlroEnrollmentGrant" g
       ON g."enrollmentId"=e."id" AND g."projectId"=e."projectId"
     WHERE e."projectId"=$1 AND e."installationId"=$2 GROUP BY e."id"`,
    scope.projectId,
    installationId,
  );
  const row = rows[0];
  if (!row) return undefined;
  return persistedScopedEnrollmentSchema.parse({
    schemaVersion: 'browser-postgres-enrollment.v1',
    tenantId: row.tenantId, projectId: row.projectId, installationId: row.installationId,
    deviceBindingDigest: row.deviceBindingDigest, clientIdentityId: row.clientIdentityId,
    state: row.state, revision: row.revision,
    currentCertificateSerial: row.currentCertificateSerial, grants: row.grants,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
    ...(row.revocationReason ? { revocationReason: row.revocationReason } : {}),
    ...(row.revocationRevision === null ? {} : { revocationRevision: row.revocationRevision }),
  });
}

export class EnrollmentLifecycleAbort extends Error {
  override readonly name = 'EnrollmentLifecycleAbort';
  constructor(readonly reason: EnrollmentLifecycleRefusal) {
    super(`Enrollment lifecycle refused: ${reason}`);
  }
}
