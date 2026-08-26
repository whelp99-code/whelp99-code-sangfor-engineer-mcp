import type { AuthorityDatabase, SqlExecutor } from './authority-store-contracts.js';

export class AuthorityEpochError extends Error { readonly name = 'AuthorityEpochError'; }
export interface AuthorityEpochPort {
  current(projectId: string, transaction?: SqlExecutor): Promise<number>;
  requireCurrent(projectId: string, signedEpoch: number, transaction?: SqlExecutor): Promise<number>;
}

export class PostgresAuthorityEpochPort implements AuthorityEpochPort {
  constructor(private readonly database: AuthorityDatabase) {}
  async current(projectId: string, transaction?: SqlExecutor): Promise<number> {
    const read = async (tx: SqlExecutor): Promise<number> => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroProjectAuthorityEpoch" ("projectId","epoch","revision") SELECT "id",0,0 FROM "BlroProject" WHERE "id"=$1 ON CONFLICT ("projectId") DO NOTHING`, projectId,
      );
      const rows = await tx.$queryRawUnsafe<Array<{ epoch: number }>>(
        `SELECT "epoch" FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$1`, projectId,
      );
      const epoch = rows[0]?.epoch;
      if (epoch === undefined) throw new AuthorityEpochError('AUTHORITY_EPOCH_MISSING');
      return epoch;
    };
    return transaction ? read(transaction) : this.database.$transaction(read, { isolationLevel: 'Serializable' });
  }
  async requireCurrent(projectId: string, signedEpoch: number, transaction?: SqlExecutor): Promise<number> {
    const current = await this.current(projectId, transaction);
    if (signedEpoch !== current) throw new AuthorityEpochError('AUTHORITY_EPOCH_STALE');
    return current;
  }
}
