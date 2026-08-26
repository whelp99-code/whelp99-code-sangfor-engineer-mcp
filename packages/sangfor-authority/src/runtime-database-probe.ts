export const CONTROL_TOWER_AUTHORITY_SCHEMA_COMPONENT = 'control-tower-authority' as const;

export type AuthorityDatabaseProbeResult = {
  readonly database: boolean;
  readonly schema: boolean;
  readonly scope: boolean;
};
type ProbeSqlExecutor = {
  readonly $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  readonly $queryRawUnsafe: <T = unknown[]>(query: string, ...values: unknown[]) => Promise<T>;
};
type ProbeDatabase = ProbeSqlExecutor & {
  readonly $transaction: <T>(work: (transaction: ProbeSqlExecutor) => Promise<T>) => Promise<T>;
};
export type AuthorityDatabaseProbeInput = {
  readonly databaseClient: ProbeDatabase;
  readonly tenantId: string;
  readonly projectId: string;
  readonly schemaVersion: string;
  readonly expectedSchemaComponent?: string;
  readonly probeOverride?: () => Promise<boolean>;
};

const SCOPED_AUTHORITY_TABLES = [
  'BlroProject', 'BlroApprovalNonce', 'BlroAuditEvent', 'BlroMembership', 'BlroDevice',
  'BlroRun', 'BlroRunStep', 'BlroApproval', 'BlroEvidenceManifest', 'BlroRagDocument',
  'BlroRagChunk', 'BlroClientEnrollment', 'BlroBrowserJobResult',
  'BlroEnrollmentIdentity', 'BlroEnrollmentCertificate', 'BlroEnrollmentGrant',
  'BlroEnrollmentBootstrapToken', 'BlroEnrollmentRotation',
] as const;

export async function probeAuthorityDatabase(
  input: AuthorityDatabaseProbeInput,
): Promise<AuthorityDatabaseProbeResult> {
  if (input.probeOverride && !await input.probeOverride()) {
    return { database: false, schema: false, scope: false };
  }
  await input.databaseClient.$queryRawUnsafe(`SELECT 1`);
  try {
    const schema = await input.databaseClient.$queryRawUnsafe<readonly { readonly version: string }[]>(
      `SELECT "version" FROM "BlroRuntimeSchema" WHERE "component"=$1`,
      input.expectedSchemaComponent ?? CONTROL_TOWER_AUTHORITY_SCHEMA_COMPONENT,
    );
    const tables = await input.databaseClient.$queryRawUnsafe<readonly { readonly count: number }[]>(
      `SELECT COUNT(*)::int AS "count" FROM pg_class
       WHERE relname = ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity`,
      SCOPED_AUTHORITY_TABLES,
    );
    if (schema[0]?.version !== input.schemaVersion || tables[0]?.count !== SCOPED_AUTHORITY_TABLES.length) {
      return { database: true, schema: false, scope: false };
    }
  } catch (error) {
    if (error instanceof Error) return { database: true, schema: false, scope: false };
    throw error;
  }
  try {
    const project = await input.databaseClient.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, input.projectId);
      return transaction.$queryRawUnsafe<readonly { readonly tenantId: string }[]>(
        `SELECT "tenantId" FROM "BlroProject" WHERE "id"=$1`, input.projectId,
      );
    });
    return { database: true, schema: true, scope: project[0]?.tenantId === input.tenantId };
  } catch (error) {
    if (error instanceof Error) return { database: true, schema: true, scope: false };
    throw error;
  }
}
