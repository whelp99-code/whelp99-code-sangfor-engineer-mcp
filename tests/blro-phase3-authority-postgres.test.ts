import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlroAuthorityStore } from '../packages/sangfor-authority/src/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
const suffix = randomUUID();
const tenantId = `authority-tenant-${suffix}`;
const projectId = `authority-project-${suffix}`;
const actorId = `authority-actor-${suffix}`;
const roleId = `authority-role-${suffix}`;

describeDb('BlroAuthorityStore on Postgres', () => {
  let prisma: PrismaClient;
  let store: BlroAuthorityStore;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL as string } } });
    store = new BlroAuthorityStore(prisma, 'test-audit-secret');
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2)`,
      tenantId,
      'Authority integration test',
    );
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`,
        projectId,
        tenantId,
        'Authority project',
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,$3,$4)`,
        actorId,
        tenantId,
        'Authority actor',
        'human_pm',
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ($1,$2,$3,$4)`,
        roleId,
        tenantId,
        'Authority writer',
        ['registry:write', 'audit:append'],
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroMembership" ("id","projectId","actorId","tenantId","roleId") VALUES ($1,$2,$3,$4,$5)`,
        `authority-membership-${suffix}`,
        projectId,
        actorId,
        tenantId,
        roleId,
      );
    });
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroDevice" WHERE "projectId"=$1`, projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroMembership" WHERE "projectId"=$1`, projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
    });
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroRole" WHERE "id"=$1`, roleId);
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroActor" WHERE "id"=$1`, actorId);
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId);
    await prisma.$disconnect();
  });

  it('persists tenant and project scope through the sole writer', async () => {
    const id = `device-${suffix}`;
    await store.registerDevice({
      id,
      tenantId,
      projectId,
      actorId,
      name: 'Scoped device',
      product: 'HCI',
      host: '127.0.0.1',
      metadata: { password: 'must-mask' },
    });
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
      return tx.$queryRawUnsafe<Array<{ tenantId: string; projectId: string; metadata: unknown }>>(
        `SELECT "tenantId","projectId","metadata" FROM "BlroDevice" WHERE "id"=$1`,
        id,
      );
    });
    expect(rows).toEqual([{
      tenantId,
      projectId,
      metadata: { password: '***' },
    }]);
  });

  it('returns precise fail-closed authorization reasons', async () => {
    await expect(store.authorize({ tenantId: 'missing', projectId, actorId, permission: 'registry:write' }))
      .resolves.toEqual({ ok: false, reason: 'TENANT_NOT_AUTHORIZED' });
    await expect(store.authorize({ tenantId, projectId, actorId, permission: 'rag:write' }))
      .resolves.toEqual({ ok: false, reason: 'ROLE_NOT_AUTHORIZED' });
  });
});
