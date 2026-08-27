import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PostgresEnrollmentRegistry } from '../../packages/sangfor-authority/src/index.js';
import { digestCanonicalOrigin } from '../../packages/shared/src/index.js';
import {
  JM_CLIENT_IDENTITY_ID,
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
  JM_ORIGIN,
  JM_PROJECT_ID,
  JM_TENANT_ID,
} from '../../tests/helpers/jm-agent-fixture.js';

export type HarnessAuthorityDatabase = {
  readonly owner: PrismaClient;
  readonly database: PrismaClient;
  readonly queryCounts: () => Promise<{ readonly jobs: number; readonly jtis: number }>;
  readonly winnerJti: (jobId: string) => Promise<string>;
  readonly revoke: () => Promise<void>;
  readonly close: () => Promise<void>;
};

export async function createHarnessAuthorityDatabase(input: {
  readonly databaseUrl: string;
  readonly ownerUrl: string;
  readonly certificateDerBase64: string;
  readonly trustedIssuerBundle: string;
}): Promise<HarnessAuthorityDatabase> {
  const owner = new PrismaClient({ datasources: { db: { url: input.ownerUrl } } });
  const database = new PrismaClient({ datasources: { db: { url: input.databaseUrl } } });
  await cleanup(owner, database);
  await owner.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,'Todo 28')`, JM_TENANT_ID);
  await database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, JM_PROJECT_ID);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,'Todo 28')`, JM_PROJECT_ID, JM_TENANT_ID);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroProjectAuthorityEpoch" ("projectId","epoch","revision") VALUES ($1,7,0)`, JM_PROJECT_ID);
  });
  const registry = new PostgresEnrollmentRegistry({ database,
    scope: { tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID },
    trustedIssuerBundle: input.trustedIssuerBundle });
  const token = randomBytes(32).toString('base64url');
  await registry.issueBootstrapToken({ tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID,
    installationId: JM_INSTALLATION_ID, deviceBindingDigest: JM_DEVICE_DIGEST,
    tokenDigest: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    grants: [{ originDigest: digestCanonicalOrigin(JM_ORIGIN, 'origin'), scope: 'browser:execute' }] });
  await registry.claimBootstrapToken({ tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID,
    installationId: JM_INSTALLATION_ID, deviceBindingDigest: JM_DEVICE_DIGEST,
    bootstrapToken: token, clientIdentityId: JM_CLIENT_IDENTITY_ID,
    certificate: { encoding: 'der-base64', value: input.certificateDerBase64 } });
  return {
    owner, database,
    queryCounts: () => counts(database),
    winnerJti: (jobId) => readWinnerJti(database, jobId),
    revoke: () => registry.revoke({ tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID,
      installationId: JM_INSTALLATION_ID, deviceBindingDigest: JM_DEVICE_DIGEST,
      expectedRevision: 1, reason: 'Todo 28 live revocation' }).then(() => undefined),
    close: async () => {
      await cleanup(owner, database);
      await Promise.all([owner.$disconnect(), database.$disconnect()]);
    },
  };
}

async function readWinnerJti(database: PrismaClient, jobId: string): Promise<string> {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, JM_PROJECT_ID);
    const rows = await transaction.$queryRawUnsafe<readonly { readonly capabilityJti: string }[]>(
      `SELECT "capabilityJti" FROM "BlroRemoteJob" WHERE "projectId"=$1 AND "jobId"=$2`,
      JM_PROJECT_ID, jobId,
    );
    const jti = rows[0]?.capabilityJti;
    if (!jti) throw new TypeError('WINNER_JTI_MISSING');
    return jti;
  });
}

async function counts(database: PrismaClient): Promise<{ readonly jobs: number; readonly jtis: number }> {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, JM_PROJECT_ID);
    const jobs = await transaction.$queryRawUnsafe<readonly { readonly count: bigint }[]>(`SELECT count(*) AS count FROM "BlroRemoteJob" WHERE "projectId"=$1`, JM_PROJECT_ID);
    const jtis = await transaction.$queryRawUnsafe<readonly { readonly count: bigint }[]>(`SELECT count(*) AS count FROM "BlroRemoteJobCapabilityJti" WHERE "projectId"=$1`, JM_PROJECT_ID);
    return { jobs: Number(jobs[0]?.count ?? 0n), jtis: Number(jtis[0]?.count ?? 0n) };
  });
}

async function cleanup(owner: PrismaClient, database: PrismaClient): Promise<void> {
  await database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, JM_PROJECT_ID);
    for (const table of ['BlroRemoteJob', 'BlroRemoteJobCapabilityJti', 'BlroEnrollmentGrant',
      'BlroEnrollmentCertificate', 'BlroEnrollmentBootstrapToken', 'BlroEnrollmentIdentity',
      'BlroProjectAuthorityEpoch']) await transaction.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId"=$1`, JM_PROJECT_ID);
    await transaction.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, JM_PROJECT_ID);
  });
  await owner.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, JM_TENANT_ID);
}
