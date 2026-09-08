import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beforeCoordinationDeadline, coordinationSignal } from './support/async-coordination.js';
import { releaseTestSourceRootOwner } from './support/postgres-source-root-owner.js';
import {
  CutoverState,
  PostgresAuthorityWriteFence,
  PostgresCutoverRepository,
  PostgresLocalWriteIntentRepository,
  digestTargetDigestMap,
} from '../packages/sangfor-authority/src/cutover/index.js';

const databaseUrl = process.env.AUTHORITY_CUTOVER_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const suffix = randomUUID();
const tenantId = `cutover-tenant-${suffix}`;
const projectId = `cutover-project-${suffix}`;
const actorId = `cutover-actor-${suffix}`;
const roleId = `cutover-role-${suffix}`;

describeDatabase('authority cutover PostgreSQL coordination', () => {
  let prisma: PrismaClient;
  let first: PostgresCutoverRepository;
  let second: PostgresCutoverRepository;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    first = new PostgresCutoverRepository(prisma);
    second = new PostgresCutoverRepository(prisma);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2)`, tenantId, 'cutover test',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,'cutover actor','service')`, actorId, tenantId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ($1,$2,'cutover writer',ARRAY['cutover:write'])`, roleId, tenantId,
    );
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`,
        projectId, tenantId, 'cutover project',
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroMembership" ("id","tenantId","projectId","actorId","roleId") VALUES ($1,$2,$3,$4,$5)`,
        `cutover-membership-${suffix}`, tenantId, projectId, actorId, roleId,
      );
    });
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroAuthorityCutoverStaging" WHERE "projectId"=$1`, projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroLocalWriteIntent" WHERE "projectId"=$1`, projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroAuthorityCutover" WHERE "projectId"=$1`, projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$1`, projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroMembership" WHERE "projectId"=$1`, projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
    });
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroRole" WHERE "id"=$1`, roleId);
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroActor" WHERE "id"=$1`, actorId);
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId);
    await prisma.$disconnect();
  });

  it('Given two engines and 32 concurrent CAS attempts, When backfill starts, Then exactly one commit wins', async () => {
    const scope = { projectId, aggregate: 'registry_services' } as const;
    const attempts = await Promise.allSettled(Array.from({ length: 32 }, async (_, index) =>
      await (index % 2 === 0 ? first : second).apply(scope, {
        kind: 'START_BACKFILL', highWaterMark: 'hwm-1', expectedRevision: 0,
      })));

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    await expect(first.read(scope)).resolves.toMatchObject({
      state: CutoverState.BACKFILLING, revision: 1, sourceHighWaterMark: 'hwm-1',
    });
  });

  it('Given a persisted checkpoint, When another engine resumes and promotes, Then state and epoch survive restart', async () => {
    const scope = { projectId, aggregate: 'registry_services' } as const;
    const shadow = await second.apply(scope, {
      kind: 'VERIFY_BACKFILL', sourceDigest: 'a'.repeat(64), targetDigest: 'a'.repeat(64), expectedRevision: 1,
    });
    const frozen = await first.freezeVerified(scope, {
      at: '2026-08-26T00:00:00.000Z', expectedRevision: shadow.revision,
      verifyFinalParity: async () => undefined,
    });
    const secondScope = { projectId, aggregate: 'audit' } as const;
    const secondStarted = await first.apply(secondScope, { kind: 'START_BACKFILL', highWaterMark: 'hwm-audit', expectedRevision: 0 });
    const secondShadow = await first.apply(secondScope, { kind: 'VERIFY_BACKFILL', sourceDigest: 'd'.repeat(64), targetDigest: 'd'.repeat(64), expectedRevision: secondStarted.revision });
    const secondFrozen = await first.freezeVerified(secondScope, { at: '2026-08-26T00:00:00.000Z', expectedRevision: secondShadow.revision, verifyFinalParity: async () => undefined });
    await second.apply(scope, { kind: 'PROMOTE', expectedRevision: frozen.revision });
    await expect(first.read(secondScope)).resolves.toMatchObject({ state: CutoverState.FROZEN, epoch: 1 });
    await second.apply(secondScope, { kind: 'PROMOTE', expectedRevision: secondFrozen.revision });
    const epochRows = await prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`,projectId); return tx.$queryRawUnsafe<Array<{epoch:number}>>(`SELECT "epoch" FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$1`,projectId); });
    expect(epochRows).toEqual([{ epoch: 1 }]);

    const restarted = new PostgresCutoverRepository(prisma);
    await expect(restarted.read(scope)).resolves.toMatchObject({
      state: CutoverState.POSTGRES_PRIMARY, epoch: 1, revision: 4,
    });
    await expect(restarted.apply(scope, { kind: 'ROLLBACK', expectedRevision: 4 }))
      .rejects.toThrow('CUTOVER_ROLLBACK_REFUSED');
  });

  it('keeps a durable pending intent across backend termination and blocks freeze before parity capture', async () => {
    const scope = { projectId, aggregate: 'evals' } as const;
    const started = await first.apply(scope, { kind: 'START_BACKFILL', highWaterMark: 'hwm-pending', expectedRevision: 0 });
    const shadow = await first.apply(scope, {
      kind: 'VERIFY_BACKFILL', sourceDigest: 'c'.repeat(64), targetDigest: 'c'.repeat(64), expectedRevision: started.revision,
    });
    const root = mkdtempSync(join(tmpdir(), 'cutover-pending-')); const path = join(root, 'evals.jsonl');
    const victim = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    let terminated: (() => void) | undefined; const termination = new Promise<void>((resolve) => { terminated = resolve; });
    const fence = new PostgresAuthorityWriteFence(prisma, {
      afterIntentCommitted: async () => {
        let pidReady: ((pid: number) => void) | undefined;
        const pid = new Promise<number>((resolve) => { pidReady = resolve; });
        const session = victim.$transaction(async (tx) => {
          const rows = await tx.$queryRawUnsafe<Array<{ pid: number }>>(`SELECT pg_backend_pid() AS pid`);
          pidReady?.(rows[0]?.pid ?? -1); await termination;
        }).catch(() => undefined);
        const backendPid = await pid;
        await prisma.$executeRawUnsafe(`SELECT pg_terminate_backend($1::int)`, backendPid); terminated?.(); await session;
        appendFileSync(path, 'escaped-after-session-loss\n', { flush: true });
        throw new Error('SIMULATED_PROCESS_LOSS');
      },
    });
    const epoch = (await first.read(scope)).epoch;
    const authority = { ...scope, tenantId, actorId, sourceRoot: root, epoch, fence } as const;
    try {
      await expect(fence.write(authority, { operation: 'evals.append', targetPaths: [path] }, () => undefined))
        .rejects.toThrow('SIMULATED_PROCESS_LOSS');
      const pending = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
        return tx.$queryRawUnsafe<Array<{ status: string }>>(`SELECT "status" FROM "BlroLocalWriteIntent" WHERE "projectId"=$1 AND "aggregate"='evals'`, projectId);
      });
      expect(pending).toEqual([{ status: 'PENDING' }]);
      let parityCaptured = false;
      await expect(second.freezeVerified(scope, {
        at: '2026-08-26T00:02:00.000Z', expectedRevision: shadow.revision,
        verifyFinalParity: async () => { parityCaptured = true; },
      })).rejects.toThrow('CUTOVER_PENDING_LOCAL_WRITE');
      expect(parityCaptured).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe('escaped-after-session-loss\n');
      const intents=new PostgresLocalWriteIntentRepository(prisma);const intent=await intents.read(projectId,(await prisma.$transaction(async tx=>{await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`,projectId);return tx.$queryRawUnsafe<Array<{writeId:string}>>(`SELECT "writeId" FROM "BlroLocalWriteIntent" WHERE "projectId"=$1 AND "aggregate"='evals'`,projectId);}))[0]?.writeId??'');
      const afterDigest=createHash('sha256').update(readFileSync(path)).digest('hex');const afterMapDigest=digestTargetDigestMap({[path]:afterDigest});
      const reconcile={tenantId,projectId,actorId,aggregate:'evals',writeId:intent.writeId,expectedOperationDigest:intent.operationDigest,expectedBeforeDigest:digestTargetDigestMap(intent.beforeDigests),expectedAfterDigest:afterMapDigest,expectedTargetPaths:[path],resolution:'COMPLETED'} as const;
      await expect(intents.reconcile({...reconcile,expectedAfterDigest:'0'.repeat(64)})).rejects.toThrow('LOCAL_WRITE_RECONCILE_EXPECTATION_MISMATCH');
      await expect(intents.reconcile(reconcile)).resolves.toMatchObject({status:'COMPLETED'});
      await expect(second.freezeVerified(scope,{at:'2026-08-26T00:02:00.000Z',expectedRevision:shadow.revision,verifyFinalParity:async()=>undefined})).resolves.toMatchObject({state:CutoverState.FROZEN});
    } finally {
      await victim.$disconnect();
      await releaseTestSourceRootOwner(prisma, { tenantId, projectId, sourceRoot: root });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Given 32 local writers racing freeze, When the shared advisory lock orders them, Then each write is included or refused before bytes change', async () => {
    const scope = { projectId, aggregate: 'feedback_lessons' } as const;
    const started = await first.apply(scope, { kind: 'START_BACKFILL', highWaterMark: 'hwm-race', expectedRevision: 0 });
    const shadow = await first.apply(scope, {
      kind: 'VERIFY_BACKFILL', sourceDigest: 'b'.repeat(64), targetDigest: 'b'.repeat(64), expectedRevision: started.revision,
    });
    const root = mkdtempSync(join(tmpdir(), 'cutover-writer-race-'));
    const path = join(root, 'feedback.jsonl');
    const fence = new PostgresAuthorityWriteFence(prisma);
    const epoch = (await first.read(scope)).epoch;
    const authority = { ...scope, tenantId, actorId, sourceRoot: root, epoch, fence } as const;
    const firstEntered = coordinationSignal();
    const firstMayFinish = coordinationSignal();
    const freezeHasLock = coordinationSignal();
    const freezeMayCommit = coordinationSignal();
    const outstanding: Promise<unknown>[] = [];
    try {
      const firstWriter = fence.write(authority, { operation: 'test.first', targetPaths: [path] }, async () => {
        firstEntered.release();
        await firstMayFinish.promise;
        appendFileSync(path, '0\n', { encoding: 'utf8', flush: true });
        return 0;
      });
      outstanding.push(firstWriter);
      await beforeCoordinationDeadline('first writer entered', firstEntered.promise);

      const pendingWriters = Array.from({ length: 15 }, (_, offset) => fence.write(authority, {
        operation: `test.pending-${offset}`, targetPaths: [path],
      }, () => appendFileSync(path, `pending-${offset}\n`, { flush: true })));
      const pendingOutcomesPromise = Promise.allSettled(pendingWriters);
      outstanding.push(pendingOutcomesPromise);
      const pendingOutcomes = await beforeCoordinationDeadline('pending writers refused', pendingOutcomesPromise);
      for (const outcome of pendingOutcomes) {
        expect(outcome).toMatchObject({
          status: 'rejected',
          reason: { code: 'LOCAL_WRITE_PENDING_RECONCILIATION' },
        });
      }
      await expect(second.freezeVerified(scope, {
        at: '2026-08-26T00:01:00.000Z', expectedRevision: shadow.revision,
        verifyFinalParity: async () => undefined,
      })).rejects.toThrow('CUTOVER_PENDING_LOCAL_WRITE');

      firstMayFinish.release();
      await beforeCoordinationDeadline('first writer finished', firstWriter);
      let includedBytes = '';
      const freezing = second.freezeVerified(scope, {
        at: '2026-08-26T00:01:00.000Z', expectedRevision: shadow.revision,
        verifyFinalParity: async () => {
          includedBytes = readFileSync(path, 'utf8');
          freezeHasLock.release();
          await freezeMayCommit.promise;
        },
      });
      outstanding.push(freezing);
      await beforeCoordinationDeadline('freeze acquired lock', freezeHasLock.promise);

      const lateWriters = Array.from({ length: 16 }, (_, offset) => fence.write(authority, {
        operation: `test.late-${offset}`, targetPaths: [path],
      }, () => appendFileSync(path, `late-${offset}\n`, { flush: true })));
      const lateOutcomesPromise = Promise.allSettled(lateWriters);
      outstanding.push(lateOutcomesPromise);
      freezeMayCommit.release();
      const [lateOutcomes, frozen] = await Promise.all([
        beforeCoordinationDeadline('late writers refused', lateOutcomesPromise),
        beforeCoordinationDeadline('freeze committed', freezing),
      ]);
      for (const outcome of lateOutcomes) {
        expect(outcome).toMatchObject({
          status: 'rejected',
          reason: { code: 'LOCAL_AUTHORITY_WRITE_FENCED' },
        });
      }
      expect(frozen.state).toBe(CutoverState.FROZEN);
      expect(readFileSync(path, 'utf8')).toBe(includedBytes);
      const before = createHash('sha256').update(readFileSync(path)).digest('hex');
      await expect(fence.write(authority, { operation: 'test.refused', targetPaths: [path] }, () => appendFileSync(path, 'late\n', { flush: true })))
        .rejects.toThrow('LOCAL_AUTHORITY_WRITE_FENCED');
      expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before);
    } finally {
      firstMayFinish.release();
      freezeMayCommit.release();
      await Promise.allSettled(outstanding);
      await releaseTestSourceRootOwner(prisma, { tenantId, projectId, sourceRoot: root });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
