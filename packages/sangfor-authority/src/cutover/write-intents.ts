import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AuthorityDatabase, SqlExecutor } from '../authority-store-contracts.js';
import { localSourceRootIdentity, type LocalWriteIntent, type LocalWriteScope } from '@sangfor/shared';
import { AuthorityCutoverError } from './errors.js';
import { CutoverState } from './types.js';

export const ABSENT_DIGEST = 'ABSENT' as const;
export const digestTargetDigestMap = (value: Readonly<Record<string, string>>): string =>
  createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function assertSafePath(rootInput: string, pathInput: string): string {
  const root = resolve(rootInput); const path = resolve(pathInput); const within = relative(root, path);
  if (within === '..' || within.startsWith(`..${sep}`)) throw new AuthorityCutoverError('LOCAL_WRITE_TARGET_OUTSIDE_SOURCE_ROOT');
  let cursor = root;
  for (const component of within.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, component);
    if (!existsSync(cursor)) break;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new AuthorityCutoverError('LOCAL_WRITE_SYMLINK_REFUSED', [cursor]);
  }
  return path;
}

export function captureTargetDigests(sourceRoot: string, paths: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(paths.map((input) => {
    const path = assertSafePath(sourceRoot, input);
    if (!existsSync(path)) return [path, ABSENT_DIGEST];
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new AuthorityCutoverError('LOCAL_WRITE_TARGET_INVALID', [path]);
    return [path, sha256(readFileSync(path))];
  }));
}

const intentRowSchema = z.object({
  writeId: z.string(), tenantId: z.string(), projectId: z.string(), actorId: z.string(), aggregate: z.string(),
  epoch: z.number().int().nonnegative(), sourceRoot: z.string(), operationDigest: z.string(), targetPaths: z.array(z.string()),
  beforeDigests: z.record(z.string()), afterDigests: z.record(z.string()).nullable(), status: z.enum(['PENDING', 'COMPLETED', 'ABORTED']),
}).strict();
export type LocalWriteIntentRow = z.infer<typeof intentRowSchema>;

async function scopeTransaction(tx: SqlExecutor, projectId: string, aggregate: string): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`, projectId, aggregate);
}

export class PostgresLocalWriteIntentRepository {
  constructor(private readonly database: AuthorityDatabase) {}

  async begin(scope: LocalWriteScope, intent: LocalWriteIntent): Promise<LocalWriteIntentRow> {
    return this.database.$transaction(async (tx) => {
      await scopeTransaction(tx, scope.projectId, scope.aggregate);
      const identity = localSourceRootIdentity(scope.sourceRoot);
      const claims = await tx.$queryRawUnsafe<Array<{ tenantId:string;sourceRoot:string;sourceDevice:string;sourceInode:string }>>(
        `SELECT "sourceOwnerTenantId" AS "tenantId","sourceRoot","sourceDevice","sourceInode" FROM "BlroAuthorityCutover" WHERE "projectId"=$1 AND "aggregate"=$2 FOR UPDATE`, scope.projectId, scope.aggregate,
      );
      let claim=claims[0];
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`,identity.sourceDevice,identity.sourceInode);
      await tx.$executeRawUnsafe(`INSERT INTO "BlroSourceRootOwner" ("sourceDevice","sourceInode","tenantId","projectId","sourceRoot") VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,identity.sourceDevice,identity.sourceInode,scope.tenantId,scope.projectId,identity.sourceRoot);
      const owners=await tx.$queryRawUnsafe<Array<{tenantId:string;projectId:string;sourceRoot:string}>>(`SELECT "tenantId","projectId","sourceRoot" FROM "BlroSourceRootOwner" WHERE "sourceDevice"=$1 AND "sourceInode"=$2`,identity.sourceDevice,identity.sourceInode);const owner=owners[0];if(!owner||owner.tenantId!==scope.tenantId||owner.projectId!==scope.projectId||owner.sourceRoot!==identity.sourceRoot)throw new AuthorityCutoverError('SOURCE_ROOT_OWNERSHIP_CONFLICT');
      if(claim&&!claim.tenantId){try{await tx.$executeRawUnsafe(`UPDATE "BlroAuthorityCutover" SET "sourceOwnerTenantId"=$3,"sourceRoot"=$4,"sourceDevice"=$5,"sourceInode"=$6 WHERE "projectId"=$1 AND "aggregate"=$2`,scope.projectId,scope.aggregate,scope.tenantId,identity.sourceRoot,identity.sourceDevice,identity.sourceInode);}catch(error){throw new AuthorityCutoverError('SOURCE_ROOT_OWNERSHIP_CONFLICT',[],{cause:error});}claim={tenantId:scope.tenantId,...identity};}
      if(!claim||claim.tenantId!==scope.tenantId||claim.sourceRoot!==identity.sourceRoot||claim.sourceDevice!==identity.sourceDevice||claim.sourceInode!==identity.sourceInode)throw new AuthorityCutoverError('SOURCE_ROOT_OWNERSHIP_CONFLICT');
      const before = captureTargetDigests(identity.sourceRoot, intent.targetPaths);
      const rows = await tx.$queryRawUnsafe<Array<{ state: string; epoch: number }>>(
        `SELECT "state","epoch" FROM "BlroAuthorityCutover" WHERE "projectId"=$1 AND "aggregate"=$2 FOR UPDATE`, scope.projectId, scope.aggregate,
      );
      const state = rows[0];
      if (!state) throw new AuthorityCutoverError('LOCAL_AUTHORITY_FENCE_MISSING');
      if (state.epoch !== scope.epoch || state.state === CutoverState.FROZEN || state.state === CutoverState.POSTGRES_PRIMARY) {
        throw new AuthorityCutoverError('LOCAL_AUTHORITY_WRITE_FENCED');
      }
      const pending = await tx.$queryRawUnsafe<Array<{ count: bigint | number }>>(
        `SELECT count(*) AS count FROM "BlroLocalWriteIntent" WHERE "projectId"=$1 AND "aggregate"=$2 AND "status"='PENDING'`,
        scope.projectId, scope.aggregate,
      );
      if (Number(pending[0]?.count ?? 0) !== 0) throw new AuthorityCutoverError('LOCAL_WRITE_PENDING_RECONCILIATION');
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroLocalWriteIntent" ("writeId","tenantId","projectId","actorId","aggregate","epoch","sourceRoot","operationDigest","targetPaths","beforeDigests","status") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,'PENDING')`,
        intent.writeId, scope.tenantId, scope.projectId, scope.actorId, scope.aggregate, scope.epoch, resolve(scope.sourceRoot),
        intent.operationDigest, JSON.stringify(intent.targetPaths), JSON.stringify(before),
      );
      return intentRowSchema.parse({
        writeId: intent.writeId, tenantId: scope.tenantId, projectId: scope.projectId, actorId: scope.actorId,
        aggregate: scope.aggregate, epoch: scope.epoch, sourceRoot: resolve(scope.sourceRoot),
        operationDigest: intent.operationDigest, targetPaths: intent.targetPaths,
        beforeDigests: before, afterDigests: null, status: 'PENDING',
      });
    }, { isolationLevel: 'ReadCommitted' });
  }

  async finish(scope: LocalWriteScope, writeId: string, status: 'COMPLETED' | 'ABORTED'): Promise<LocalWriteIntentRow> {
    return this.database.$transaction(async (tx) => {
      await scopeTransaction(tx, scope.projectId, scope.aggregate);
      const rows = await tx.$queryRawUnsafe<unknown[]>(
        `SELECT "writeId","tenantId","projectId","actorId","aggregate","epoch","sourceRoot","operationDigest","targetPaths","beforeDigests","afterDigests","status" FROM "BlroLocalWriteIntent" WHERE "writeId"=$1 FOR UPDATE`, writeId,
      );
      const current = intentRowSchema.parse(rows[0]);
      if (current.status !== 'PENDING') return current;
      const after = captureTargetDigests(current.sourceRoot, current.targetPaths);
      if (status === 'ABORTED' && JSON.stringify(after) !== JSON.stringify(current.beforeDigests)) {
        throw new AuthorityCutoverError('LOCAL_WRITE_OUTCOME_INDETERMINATE');
      }
      await tx.$executeRawUnsafe(
        `UPDATE "BlroLocalWriteIntent" SET "status"=$2,"afterDigests"=$3::jsonb,"resolvedAt"=CURRENT_TIMESTAMP WHERE "writeId"=$1 AND "status"='PENDING'`,
        writeId, status, JSON.stringify(after),
      );
      return { ...current, status, afterDigests: after };
    }, { isolationLevel: 'ReadCommitted' });
  }

  async reconcile(input: {
    readonly tenantId: string; readonly projectId: string; readonly actorId: string; readonly aggregate: string;
    readonly writeId: string; readonly expectedOperationDigest: string; readonly expectedBeforeDigest: string;
    readonly expectedAfterDigest: string; readonly expectedTargetPaths: readonly string[]; readonly resolution: 'COMPLETED' | 'ABORTED';
  }): Promise<LocalWriteIntentRow> {
    const current = await this.read(input.projectId, input.writeId);
    if (current.tenantId !== input.tenantId || current.projectId !== input.projectId || current.actorId !== input.actorId
      || current.aggregate !== input.aggregate || current.operationDigest !== input.expectedOperationDigest
      || JSON.stringify(current.targetPaths) !== JSON.stringify(input.expectedTargetPaths.map((path) => resolve(path)).sort())
      || digestTargetDigestMap(current.beforeDigests) !== input.expectedBeforeDigest) {
      throw new AuthorityCutoverError('LOCAL_WRITE_RECONCILE_EXPECTATION_MISMATCH');
    }
    const observed = captureTargetDigests(current.sourceRoot, current.targetPaths);
    if (digestTargetDigestMap(observed) !== input.expectedAfterDigest) {
      throw new AuthorityCutoverError('LOCAL_WRITE_RECONCILE_EXPECTATION_MISMATCH');
    }
    return this.finish({
      tenantId: current.tenantId, projectId: current.projectId, actorId: current.actorId,
      aggregate: current.aggregate, epoch: current.epoch, sourceRoot: current.sourceRoot,
    }, input.writeId, input.resolution);
  }

  async read(projectId: string, writeId: string): Promise<LocalWriteIntentRow> {
    return this.database.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      const rows = await tx.$queryRawUnsafe<unknown[]>(`SELECT "writeId","tenantId","projectId","actorId","aggregate","epoch","sourceRoot","operationDigest","targetPaths","beforeDigests","afterDigests","status" FROM "BlroLocalWriteIntent" WHERE "writeId"=$1`, writeId);
      if (!rows[0]) throw new AuthorityCutoverError('LOCAL_WRITE_INTENT_NOT_FOUND');
      return intentRowSchema.parse(rows[0]);
    });
  }
}
