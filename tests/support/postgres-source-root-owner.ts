import type { PrismaClient } from '@prisma/client';
import { localSourceRootIdentity } from '../../packages/shared/src/index.js';

type TestSourceRootOwner = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly sourceRoot: string;
};

export async function releaseTestSourceRootOwner(
  database: PrismaClient,
  owner: TestSourceRootOwner,
): Promise<void> {
  const identity = localSourceRootIdentity(owner.sourceRoot);
  await database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT set_config('app.project_id',$1,true)`,
      owner.projectId,
    );
    const deleted = await transaction.$executeRawUnsafe(
      `DELETE FROM "BlroSourceRootOwner"
       WHERE "projectId"=$1 AND "tenantId"=$2 AND "sourceRoot"=$3
         AND "sourceDevice"=$4 AND "sourceInode"=$5`,
      owner.projectId,
      owner.tenantId,
      identity.sourceRoot,
      identity.sourceDevice,
      identity.sourceInode,
    );
    if (deleted !== 1) throw new TypeError('TEST_SOURCE_ROOT_OWNER_RELEASE_FAILED');
  });
}
