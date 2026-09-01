import type { AuthorityDatabase, SqlExecutor } from '../authority-store-contracts.js';
import type { AuthorityAggregate } from '../migration-manifest.js';
import { assertCleanupAllowed, checkpointRecords, setProjectScope } from './target-common.js';
import type { CutoverRecord, CutoverTargetAdapter } from './types.js';

export type TargetScope = { readonly tenantId: string; readonly projectId: string; readonly actorId: string };

export abstract class AggregatePostgresTarget implements CutoverTargetAdapter {
  abstract readonly aggregate: AuthorityAggregate;
  constructor(protected readonly database: AuthorityDatabase, protected readonly scope: TargetScope) {}
  protected abstract upsertProduct(tx: SqlExecutor, record: CutoverRecord): Promise<void>;
  protected abstract readProduct(tx: SqlExecutor, projectId: string): Promise<readonly CutoverRecord[]>;
  protected abstract cleanupProduct(tx: SqlExecutor, projectId: string): Promise<void>;

  async stage(input: { readonly projectId: string; readonly highWaterMark: string; readonly records: readonly CutoverRecord[] }): Promise<void> {
    await this.database.$transaction(async (tx) => {
      await setProjectScope(tx, input.projectId);
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`, input.projectId, this.aggregate);
      for (const record of input.records) await this.upsertProduct(tx, record);
      await checkpointRecords(tx, { ...input, aggregate: this.aggregate });
    }, { isolationLevel: 'Serializable' });
  }
  async canonicalRecords(projectId: string, _hwm: string, transaction?: SqlExecutor): Promise<readonly CutoverRecord[]> {
    if (transaction) return this.readProduct(transaction, projectId);
    return this.database.$transaction(async (tx) => {
      await setProjectScope(tx, projectId); return this.readProduct(tx, projectId);
    }, { isolationLevel: 'Serializable' });
  }
  async shadowRead(projectId: string): Promise<readonly CutoverRecord[]> { return this.canonicalRecords(projectId, 'shadow'); }
  async cleanup(projectId: string): Promise<void> {
    await this.database.$transaction(async (tx) => {
      await setProjectScope(tx, projectId); await assertCleanupAllowed(tx, projectId, this.aggregate);
      await this.cleanupProduct(tx, projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroAuthorityCutoverStaging" WHERE "projectId"=$1 AND "aggregate"=$2`, projectId, this.aggregate);
    }, { isolationLevel: 'Serializable' });
  }
}
