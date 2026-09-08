import { z } from 'zod';
import { localSourceRootIdentity } from '@sangfor/shared';
import type { AuthorityDatabase, SqlExecutor } from '../authority-store-contracts.js';
import { AUTHORITY_MANIFEST, type AuthorityAggregate } from '../migration-manifest.js';
import { AuthorityCutoverError } from './errors.js';
import { transitionCutover } from './transition.js';
import { CutoverState, type CutoverAggregateState, type CutoverCommand, type CutoverScope } from './types.js';

const rowSchema = z.object({
  projectId: z.string(), aggregate: z.string(), state: z.nativeEnum(CutoverState),
  epoch: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  sourceHighWaterMark: z.string().nullable(), sourceDigest: z.string().nullable(),
  targetDigest: z.string().nullable(), localWriteFencedAt: z.union([z.date(), z.string()]).nullable(),
}).strict();

function isAuthorityAggregate(value: string): value is AuthorityAggregate {
  return AUTHORITY_MANIFEST.entries.some((entry) => entry.aggregate === value);
}

function parseRow(input: unknown): CutoverAggregateState {
  const parsed = rowSchema.safeParse(input);
  if (!parsed.success) throw new AuthorityCutoverError('CUTOVER_DATABASE_ROW_INVALID', [], { cause: parsed.error });
  if (!isAuthorityAggregate(parsed.data.aggregate)) throw new AuthorityCutoverError('CUTOVER_AGGREGATE_UNSUPPORTED');
  return {
    ...parsed.data,
    aggregate: parsed.data.aggregate,
    localWriteFencedAt: parsed.data.localWriteFencedAt === null
      ? null : new Date(parsed.data.localWriteFencedAt).toISOString(),
  };
}

async function setScope(tx: SqlExecutor, projectId: string): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
}

export class PostgresCutoverRepository {
  constructor(private readonly database: AuthorityDatabase) {}

  async claimSourceRoot(scope: CutoverScope & { tenantId: string; sourceRoot: string }): Promise<void> {
    const identity = localSourceRootIdentity(scope.sourceRoot);
    await this.database.$transaction(async (tx) => {
      await setScope(tx, scope.projectId);
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`, scope.projectId, 'authority-campaign');
      await tx.$executeRawUnsafe(`INSERT INTO "BlroProjectAuthorityEpoch" ("projectId","epoch","revision") SELECT "id",0,0 FROM "BlroProject" WHERE "id"=$1 ON CONFLICT DO NOTHING`,scope.projectId);
      const epochs=await tx.$queryRawUnsafe<Array<{epoch:number}>>(`SELECT "epoch" FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$1 FOR UPDATE`,scope.projectId);
      await tx.$executeRawUnsafe(`INSERT INTO "BlroAuthorityCutover" ("projectId","aggregate","state","epoch","revision") VALUES ($1,$2,'LOCAL_PRIMARY',$3,0) ON CONFLICT DO NOTHING`,scope.projectId,scope.aggregate,epochs[0]?.epoch);
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`,identity.sourceDevice,identity.sourceInode);
      await tx.$executeRawUnsafe(`INSERT INTO "BlroSourceRootOwner" ("sourceDevice","sourceInode","tenantId","projectId","sourceRoot") VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,identity.sourceDevice,identity.sourceInode,scope.tenantId,scope.projectId,identity.sourceRoot);
      const owners=await tx.$queryRawUnsafe<Array<{tenantId:string;projectId:string;sourceRoot:string}>>(`SELECT "tenantId","projectId","sourceRoot" FROM "BlroSourceRootOwner" WHERE "sourceDevice"=$1 AND "sourceInode"=$2`,identity.sourceDevice,identity.sourceInode);const owner=owners[0];if(!owner||owner.tenantId!==scope.tenantId||owner.projectId!==scope.projectId||owner.sourceRoot!==identity.sourceRoot)throw new AuthorityCutoverError('SOURCE_ROOT_OWNERSHIP_CONFLICT');
      try { await tx.$executeRawUnsafe(`UPDATE "BlroAuthorityCutover" SET "sourceOwnerTenantId"=COALESCE("sourceOwnerTenantId",$3),"sourceRoot"=COALESCE("sourceRoot",$4),"sourceDevice"=COALESCE("sourceDevice",$5),"sourceInode"=COALESCE("sourceInode",$6) WHERE "projectId"=$1 AND "aggregate"=$2`,scope.projectId,scope.aggregate,scope.tenantId,identity.sourceRoot,identity.sourceDevice,identity.sourceInode); }
      catch(error){throw new AuthorityCutoverError('SOURCE_ROOT_OWNERSHIP_CONFLICT',[],{cause:error});}
      const rows=await tx.$queryRawUnsafe<Array<{tenantId:string;sourceRoot:string;sourceDevice:string;sourceInode:string}>>(`SELECT "sourceOwnerTenantId" AS "tenantId","sourceRoot","sourceDevice","sourceInode" FROM "BlroAuthorityCutover" WHERE "projectId"=$1 AND "aggregate"=$2`,scope.projectId,scope.aggregate);
      const row=rows[0];if(!row||row.tenantId!==scope.tenantId||row.sourceRoot!==identity.sourceRoot||row.sourceDevice!==identity.sourceDevice||row.sourceInode!==identity.sourceInode)throw new AuthorityCutoverError('SOURCE_ROOT_OWNERSHIP_CONFLICT');
    },{isolationLevel:'ReadCommitted'});
  }

  async read(scope: CutoverScope): Promise<CutoverAggregateState> {
    return this.database.$transaction(async (tx) => {
      await setScope(tx, scope.projectId);
      const rows = await tx.$queryRawUnsafe<unknown[]>(
        `SELECT "projectId","aggregate","state","epoch","revision","sourceHighWaterMark","sourceDigest","targetDigest","localWriteFencedAt"
         FROM "BlroAuthorityCutover" WHERE "projectId"=$1 AND "aggregate"=$2`,
        scope.projectId, scope.aggregate,
      );
      if (rows.length === 0) return {
        ...scope, state: CutoverState.LOCAL_PRIMARY, epoch: 0, revision: 0,
        sourceHighWaterMark: null, sourceDigest: null, targetDigest: null, localWriteFencedAt: null,
      };
      if (rows.length !== 1) throw new AuthorityCutoverError('CUTOVER_DATABASE_DUPLICATE');
      return parseRow(rows[0]);
    }, { isolationLevel: 'ReadCommitted' });
  }

  async freezeVerified(
    scope: CutoverScope,
    input: { readonly at: string; readonly expectedRevision: number; readonly verifyFinalParity: (transaction: SqlExecutor) => Promise<void> },
  ): Promise<CutoverAggregateState> {
    return this.database.$transaction(async (tx) => {
      await setScope(tx, scope.projectId);
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, scope.projectId, scope.aggregate);
      const rows = await tx.$queryRawUnsafe<unknown[]>(
        `SELECT "projectId","aggregate","state","epoch","revision","sourceHighWaterMark","sourceDigest","targetDigest","localWriteFencedAt"
         FROM "BlroAuthorityCutover" WHERE "projectId"=$1 AND "aggregate"=$2 FOR UPDATE`,
        scope.projectId, scope.aggregate,
      );
      const row = rows[0];
      if (!row) throw new AuthorityCutoverError('CUTOVER_LOCK_LOST');
      const current = parseRow(row);
      if (current.revision !== input.expectedRevision) throw new AuthorityCutoverError('CUTOVER_STALE_REVISION');
      const pending = await tx.$queryRawUnsafe<Array<{ count: bigint | number }>>(
        `SELECT count(*) AS count FROM "BlroLocalWriteIntent" WHERE "projectId"=$1 AND "aggregate"=$2 AND "status"='PENDING'`,
        scope.projectId, scope.aggregate,
      );
      if (Number(pending[0]?.count ?? 0) !== 0) throw new AuthorityCutoverError('CUTOVER_PENDING_LOCAL_WRITE');
      await input.verifyFinalParity(tx);
      await tx.$executeRawUnsafe(`UPDATE "BlroAuthorityCutover" SET "sourceMarkerRequired"=true WHERE "projectId"=$1 AND "aggregate"=$2 AND "epoch"=$3 AND "sourceRoot" IS NOT NULL`,scope.projectId,scope.aggregate,current.epoch);
      const next = transitionCutover(current, { kind: 'FREEZE', at: input.at, expectedRevision: current.revision });
      const changed = await tx.$executeRawUnsafe(
        `UPDATE "BlroAuthorityCutover" SET "state"=$3,"revision"=$4,"localWriteFencedAt"=$5::timestamptz,"updatedAt"=CURRENT_TIMESTAMP
         WHERE "projectId"=$1 AND "aggregate"=$2 AND "revision"=$6`,
        scope.projectId, scope.aggregate, next.state, next.revision, next.localWriteFencedAt, current.revision,
      );
      if (changed !== 1) throw new AuthorityCutoverError('CUTOVER_LOCK_LOST');
      return next;
    }, { isolationLevel: 'ReadCommitted' });
  }

  private async invalidateEpoch(tx: SqlExecutor, scope: CutoverScope, epoch: number): Promise<void> {
    if (scope.aggregate === 'approvals_nonces') {
      await tx.$executeRawUnsafe(`UPDATE "BlroApproval" SET "status"='frozen_epoch' WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "status" NOT IN ('consumed','expired','frozen_epoch')`, scope.projectId, epoch);
      await tx.$executeRawUnsafe(`UPDATE "BlroApprovalNonce" SET "consumedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "consumedAt" IS NULL`, scope.projectId, epoch);
    }
    if (scope.aggregate === 'browser_job_authority') await tx.$executeRawUnsafe(`UPDATE "BlroRemoteJob" SET "state"='indeterminate',"indeterminateAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "state" NOT IN ('result_retained','indeterminate')`, scope.projectId, epoch);
    if (scope.aggregate === 'runs_steps') await tx.$executeRawUnsafe(`UPDATE "BlroRun" SET "status"='frozen_epoch',"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "status" NOT IN ('succeeded','failed','frozen_epoch')`, scope.projectId, epoch);
    if (scope.aggregate === 'approvals_nonces') {
      const rows = await tx.$queryRawUnsafe<Array<{ count: bigint | number }>>(
        `SELECT (SELECT count(*) FROM "BlroApproval" WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "status" NOT IN ('consumed','expired','frozen_epoch')) + (SELECT count(*) FROM "BlroApprovalNonce" WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "consumedAt" IS NULL) AS count`, scope.projectId, epoch,
      );
      if (Number(rows[0]?.count ?? 0) !== 0) throw new AuthorityCutoverError('CUTOVER_EPOCH_INVALIDATION_INCOMPLETE');
    }
    if (scope.aggregate === 'browser_job_authority') {
      const rows = await tx.$queryRawUnsafe<Array<{ count: bigint | number }>>(
        `SELECT count(*) AS count FROM "BlroRemoteJob" WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "state" NOT IN ('result_retained','indeterminate')`, scope.projectId, epoch,
      );
      if (Number(rows[0]?.count ?? 0) !== 0) throw new AuthorityCutoverError('CUTOVER_EPOCH_INVALIDATION_INCOMPLETE');
    }
  }

  private async invalidateAllOperationalAuthority(tx: SqlExecutor, projectId: string, epoch: number): Promise<void> {
    await tx.$executeRawUnsafe(
      `UPDATE "BlroRun" SET "status"='frozen_epoch',"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "status" NOT IN ('succeeded','failed','frozen_epoch')`, projectId, epoch,
    );
    await tx.$executeRawUnsafe(
      `UPDATE "BlroApproval" SET "status"='frozen_epoch' WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "status" NOT IN ('consumed','expired','frozen_epoch')`, projectId, epoch,
    );
    await tx.$executeRawUnsafe(
      `UPDATE "BlroApprovalNonce" SET "consumedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "consumedAt" IS NULL`, projectId, epoch,
    );
    await tx.$executeRawUnsafe(
      `UPDATE "BlroRemoteJob" SET "state"='indeterminate',"indeterminateAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "state" NOT IN ('result_retained','indeterminate')`, projectId, epoch,
    );
  }

  async verifyEpochInvalidated(scope: CutoverScope, epoch: number): Promise<void> {
    await this.database.$transaction(async (tx) => {
      await setScope(tx, scope.projectId);
      let count = 0;
      if (scope.aggregate === 'approvals_nonces') {
        const rows = await tx.$queryRawUnsafe<Array<{ count: bigint | number }>>(
          `SELECT (SELECT count(*) FROM "BlroApproval" WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "status" NOT IN ('consumed','expired','frozen_epoch'))
            + (SELECT count(*) FROM "BlroApprovalNonce" WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "consumedAt" IS NULL) AS count`,
          scope.projectId, epoch,
        );
        count = Number(rows[0]?.count ?? 0);
      } else if (scope.aggregate === 'browser_job_authority') {
        const rows = await tx.$queryRawUnsafe<Array<{ count: bigint | number }>>(
          `SELECT count(*) AS count FROM "BlroRemoteJob" WHERE "projectId"=$1 AND "authorityEpoch"=$2 AND "state" NOT IN ('result_retained','indeterminate')`,
          scope.projectId, epoch,
        );
        count = Number(rows[0]?.count ?? 0);
      } else {
        throw new AuthorityCutoverError('CUTOVER_INVALIDATION_POLICY_INVALID');
      }
      if (count !== 0) throw new AuthorityCutoverError('CUTOVER_EPOCH_INVALIDATION_INCOMPLETE');
    }, { isolationLevel: 'ReadCommitted' });
  }

  async rollbackVerified(
    scope: CutoverScope,
    input: { readonly expectedRevision: number; readonly removeMarker: () => void },
  ): Promise<CutoverAggregateState> {
    return this.database.$transaction(async (tx) => {
      await setScope(tx, scope.projectId);
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`, scope.projectId, scope.aggregate);
      const rows = await tx.$queryRawUnsafe<unknown[]>(
        `SELECT "projectId","aggregate","state","epoch","revision","sourceHighWaterMark","sourceDigest","targetDigest","localWriteFencedAt" FROM "BlroAuthorityCutover" WHERE "projectId"=$1 AND "aggregate"=$2 FOR UPDATE`,
        scope.projectId, scope.aggregate,
      );
      if (!rows[0]) throw new AuthorityCutoverError('CUTOVER_LOCK_LOST');
      const current = parseRow(rows[0]);
      const pending = await tx.$queryRawUnsafe<Array<{ count: bigint | number }>>(
        `SELECT count(*) AS count FROM "BlroLocalWriteIntent" WHERE "projectId"=$1 AND "aggregate"=$2 AND "status"='PENDING'`, scope.projectId, scope.aggregate,
      );
      if (Number(pending[0]?.count ?? 0) !== 0) throw new AuthorityCutoverError('CUTOVER_PENDING_LOCAL_WRITE');
      const next = transitionCutover(current, { kind: 'ROLLBACK', expectedRevision: input.expectedRevision });
      input.removeMarker();
      const changed = await tx.$executeRawUnsafe(
        `UPDATE "BlroAuthorityCutover" SET "state"=$3,"revision"=$4,"sourceHighWaterMark"=NULL,"sourceDigest"=NULL,"targetDigest"=NULL,"localWriteFencedAt"=NULL,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1 AND "aggregate"=$2 AND "revision"=$5`,
        scope.projectId, scope.aggregate, next.state, next.revision, current.revision,
      );
      if (changed !== 1) throw new AuthorityCutoverError('CUTOVER_LOCK_LOST');
      return next;
    }, { isolationLevel: 'ReadCommitted' });
  }

  async apply(scope: CutoverScope, command: CutoverCommand): Promise<CutoverAggregateState> {
    return this.database.$transaction(async (tx) => {
      await setScope(tx, scope.projectId);
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, scope.projectId, 'authority-campaign',
      );
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, scope.projectId, scope.aggregate,
      );
      await tx.$executeRawUnsafe(`INSERT INTO "BlroProjectAuthorityEpoch" ("projectId","epoch","revision") SELECT "id",0,0 FROM "BlroProject" WHERE "id"=$1 ON CONFLICT DO NOTHING`,scope.projectId);
      const epochRows = await tx.$queryRawUnsafe<Array<{ epoch: number }>>(
        `SELECT "epoch" FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$1 FOR UPDATE`, scope.projectId,
      );
      const authorityEpoch = epochRows[0]?.epoch;
      if (authorityEpoch === undefined) throw new AuthorityCutoverError('AUTHORITY_EPOCH_MISSING');
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroAuthorityCutover" ("projectId","aggregate","state","epoch","revision")
         VALUES ($1,$2,'LOCAL_PRIMARY',$3,0) ON CONFLICT ("projectId","aggregate") DO NOTHING`,
        scope.projectId, scope.aggregate, authorityEpoch,
      );
      const rows = await tx.$queryRawUnsafe<unknown[]>(
        `SELECT "projectId","aggregate","state","epoch","revision","sourceHighWaterMark","sourceDigest","targetDigest","localWriteFencedAt"
         FROM "BlroAuthorityCutover" WHERE "projectId"=$1 AND "aggregate"=$2 FOR UPDATE`,
        scope.projectId, scope.aggregate,
      );
      const row = rows[0];
      if (!row) throw new AuthorityCutoverError('CUTOVER_LOCK_LOST');
      const current = parseRow(row);
      let next = transitionCutover(current, command);
      if (next === current) return current;
      if (command.kind === 'PROMOTE') {
        const existing = await tx.$queryRawUnsafe<Array<{ count: bigint | number }>>(
          `SELECT count(*) AS count FROM "BlroAuthorityCutover" WHERE "projectId"=$1 AND "state"='POSTGRES_PRIMARY'`, scope.projectId,
        );
        let promotedEpoch = authorityEpoch;
        if (Number(existing[0]?.count ?? 0) === 0) {
          const promoted = await tx.$queryRawUnsafe<Array<{ epoch: number }>>(
            `UPDATE "BlroProjectAuthorityEpoch" SET "epoch"="epoch"+1,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1 AND "epoch"=$2 RETURNING "epoch"`,
            scope.projectId, current.epoch,
          );
          if (promoted[0]?.epoch === undefined) throw new AuthorityCutoverError('CUTOVER_STALE_EPOCH');
          promotedEpoch = promoted[0].epoch;
          await this.invalidateAllOperationalAuthority(tx, scope.projectId, current.epoch);
          await tx.$executeRawUnsafe(
            `UPDATE "BlroAuthorityCutover" SET "epoch"=$2,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1 AND "state"<>'POSTGRES_PRIMARY' AND "epoch"=$3`,
            scope.projectId, promotedEpoch, current.epoch,
          );
        }
        next = { ...next, epoch: promotedEpoch };
      }
      const changed = await tx.$executeRawUnsafe(
        `UPDATE "BlroAuthorityCutover" SET "state"=$3,"epoch"=$4,"revision"=$5,
          "sourceHighWaterMark"=$6,"sourceDigest"=$7,"targetDigest"=$8,"localWriteFencedAt"=$9::timestamptz,"updatedAt"=CURRENT_TIMESTAMP
         WHERE "projectId"=$1 AND "aggregate"=$2 AND "revision"=$10`,
        scope.projectId, scope.aggregate, next.state, next.epoch, next.revision,
        next.sourceHighWaterMark, next.sourceDigest, next.targetDigest, next.localWriteFencedAt, current.revision,
      );
      if (changed !== 1) throw new AuthorityCutoverError('CUTOVER_LOCK_LOST');
      return next;
    }, { isolationLevel: 'ReadCommitted' });
  }
}
