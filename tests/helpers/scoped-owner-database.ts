import type { PrismaClient } from '@prisma/client';

type ScopedOwnerSqlInput = {
  readonly owner: PrismaClient;
  readonly projectId: string;
  readonly query: string;
  readonly values?: readonly unknown[];
};

export async function scopedOwnerQuery<T>(
  input: ScopedOwnerSqlInput,
): Promise<readonly T[]> {
  return input.owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT set_config('app.project_id',$1,true)`,
      input.projectId,
    );
    return transaction.$queryRawUnsafe<readonly T[]>(
      input.query,
      ...(input.values ?? []),
    );
  });
}

export async function scopedOwnerExecute(
  input: ScopedOwnerSqlInput,
): Promise<number> {
  return input.owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT set_config('app.project_id',$1,true)`,
      input.projectId,
    );
    return transaction.$executeRawUnsafe(input.query, ...(input.values ?? []));
  });
}
