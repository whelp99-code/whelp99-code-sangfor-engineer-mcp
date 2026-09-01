import type { PrismaClient } from '@prisma/client';

export type TaskAuthorityLineage = {
  readonly tenantId: string;
  readonly projectIds: readonly [string, string];
};

type TaskAuthorityDatabaseInput = {
  readonly owner: PrismaClient;
  readonly lineage: TaskAuthorityLineage;
};

export async function seedTaskAuthority(
  input: TaskAuthorityDatabaseInput,
): Promise<void> {
  await input.owner.$executeRawUnsafe(
    `INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2)`,
    input.lineage.tenantId,
    'Todo 22 remote jobs',
  );
  for (const projectId of input.lineage.projectIds) {
    await input.owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`,
        projectId,
        input.lineage.tenantId,
        projectId,
      );
    });
  }
}

export async function clearTaskAuthority(
  input: TaskAuthorityDatabaseInput,
): Promise<void> {
  for (const projectId of input.lineage.projectIds) {
    await input.owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      for (const table of [
        'BlroRemoteJob', 'BlroRemoteJobCapabilityJti', 'BlroEnrollmentRotation',
        'BlroEnrollmentGrant', 'BlroEnrollmentCertificate', 'BlroEnrollmentIdentity',
        'BlroEnrollmentBootstrapToken',
      ]) await transaction.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId"=$1`, projectId);
    });
  }
}

export async function deleteTaskAuthority(
  input: TaskAuthorityDatabaseInput,
): Promise<void> {
  await clearTaskAuthority(input);
  for (const projectId of input.lineage.projectIds) {
    await input.owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
    });
  }
  await input.owner.$executeRawUnsafe(
    `DELETE FROM "BlroTenant" WHERE "id"=$1`,
    input.lineage.tenantId,
  );
}
