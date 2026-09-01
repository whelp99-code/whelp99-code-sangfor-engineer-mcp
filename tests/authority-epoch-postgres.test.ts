import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresSingleUseNonceStore } from '../packages/sangfor-approval/src/index.js';
import { BlroAuthorityStore, PostgresAuthorityEpochPort, PostgresCutoverRepository } from '../packages/sangfor-authority/src/index.js';

const url = process.env.AUTHORITY_CUTOVER_DATABASE_URL;
const database = url ? describe : describe.skip;
const suffix = randomUUID(); const tenantId = `epoch-t-${suffix}`; const projectId = `epoch-p-${suffix}`;
const actorId = `epoch-a-${suffix}`; const roleId = `epoch-r-${suffix}`;

database('canonical operational authority epoch', () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,'epoch')`, tenantId);
    await prisma.$executeRawUnsafe(`INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,'actor','service')`, actorId, tenantId);
    await prisma.$executeRawUnsafe(`INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ($1,$2,'role',$3)`, roleId, tenantId, ['run:write', 'approval:write']);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await tx.$executeRawUnsafe(`INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,'project')`, projectId, tenantId);
      await tx.$executeRawUnsafe(`INSERT INTO "BlroMembership" ("id","projectId","actorId","tenantId","roleId") VALUES ($1,$2,$3,$4,$5)`, `epoch-m-${suffix}`, projectId, actorId, tenantId, roleId);
    });
  });
  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      for (const table of ['BlroApprovalNonce','BlroApproval','BlroRun','BlroAuthorityCutover','BlroMembership','BlroProjectAuthorityEpoch']) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId"=$1`, projectId);
      }
      await tx.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
    });
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroRole" WHERE "id"=$1`, roleId);
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroActor" WHERE "id"=$1`, actorId);
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId); await prisma.$disconnect();
  });

  it('persists explicit current epochs, invalidates epoch zero on promotion, and rejects replay', async () => {
    const epochs = new PostgresAuthorityEpochPort(prisma); const store = new BlroAuthorityStore(prisma);
    expect(await epochs.current(projectId)).toBe(0);
    await store.createRun({ tenantId, projectId, actorId, id: `run-old-${suffix}`, status: 'running', toolProfileVersion: 'v1', sourceSystem: 'test', authorityEpoch: 0 });
    await store.recordApproval({ tenantId, projectId, actorId, id: `approval-old-${suffix}`, actionHash: 'a'.repeat(64), expiresAt: '2026-08-27T00:00:00.000Z', status: 'pending', authorityEpoch: 0 });
    const nonces = new PostgresSingleUseNonceStore({ database: prisma });
    await expect(nonces.consume(projectId, `nonce-old-${suffix}`, '2026-08-27T00:00:00.000Z', 0, new Date('2026-08-26T00:00:00.000Z'))).resolves.toMatchObject({ ok: true });
    const repository = new PostgresCutoverRepository(prisma); const scope = { projectId, aggregate: 'evals' } as const;
    const started = await repository.apply(scope, { kind: 'START_BACKFILL', highWaterMark: 'hwm', expectedRevision: 0 });
    const shadow = await repository.apply(scope, { kind: 'VERIFY_BACKFILL', sourceDigest: 'a'.repeat(64), targetDigest: 'a'.repeat(64), expectedRevision: started.revision });
    const frozen = await repository.freezeVerified(scope, { at: '2026-08-26T01:00:00.000Z', expectedRevision: shadow.revision, verifyFinalParity: async () => undefined });
    await repository.apply(scope, { kind: 'PROMOTE', expectedRevision: frozen.revision });
    expect(await epochs.current(projectId)).toBe(1);
    await expect(store.createRun({ tenantId, projectId, actorId, id: `run-replay-${suffix}`, status: 'running', toolProfileVersion: 'v1', sourceSystem: 'test', authorityEpoch: 0 })).rejects.toThrow('AUTHORITY_EPOCH_STALE');
    await store.createRun({ tenantId, projectId, actorId, id: `run-new-${suffix}`, status: 'running', toolProfileVersion: 'v1', sourceSystem: 'test', authorityEpoch: 1 });
    await expect(nonces.consume(projectId, `nonce-replay-${suffix}`, '2026-08-27T00:00:00.000Z', 0, new Date('2026-08-26T00:00:00.000Z'))).resolves.toMatchObject({ ok: false });
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      return tx.$queryRawUnsafe<Array<{ status: string }>>(`SELECT "status" FROM "BlroRun" WHERE "id"=$1`, `run-old-${suffix}`);
    });
    expect(rows[0]?.status).toBe('frozen_epoch');
  });
});
