import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresSingleUseNonceStore } from '../../packages/sangfor-approval/src/postgres-nonce-store.js';
import {
  AuthorityStorePersistenceError,
  BlroAuthorityStore,
  verifyAuditEvents,
  type AuthorityDatabase,
  type SqlExecutor,
} from '../../packages/sangfor-authority/src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const ownerUrl = process.env['BLRO_OWNER_DATABASE_URL'];
if (!databaseUrl || !ownerUrl || process.env['SANGFOR_REQUIRE_POSTGRES_TESTS'] !== '1') {
  throw new Error('MANDATORY_POSTGRES_DATABASE_REQUIRED');
}

const suffix = randomUUID();
const tenantId = `mandatory-tenant-${suffix}`;
const projectId = `mandatory-project-${suffix}`;
const actorId = `mandatory-actor-${suffix}`;
const roleId = `mandatory-role-${suffix}`;
const auditSecret = `mandatory-audit-${suffix}`;

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((ready) => { resolve = ready; });
  return { promise, resolve: (value) => resolve?.(value) };
}

function barrier(participants: number): () => Promise<void> {
  let arrived = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived === participants) release?.();
    await released;
  };
}

describe('Todo 24 PostgreSQL authority concurrency', () => {
  const firstDatabase = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const secondDatabase = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const firstNonce = new PostgresSingleUseNonceStore({ database: firstDatabase });
  const secondNonce = new PostgresSingleUseNonceStore({ database: secondDatabase });
  const firstAuthority = new BlroAuthorityStore(firstDatabase, auditSecret);
  const secondAuthority = new BlroAuthorityStore(secondDatabase, auditSecret);

  beforeAll(async () => {
    await firstDatabase.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,'mandatory concurrency')`, tenantId);
    await firstDatabase.$executeRawUnsafe(`INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,'mandatory actor','service')`, actorId, tenantId);
    await firstDatabase.$executeRawUnsafe(`INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ($1,$2,'mandatory role',ARRAY['audit:write'])`, roleId, tenantId);
    await firstDatabase.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,'mandatory project')`, projectId, tenantId);
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroMembership" ("id","tenantId","projectId","actorId","roleId") VALUES ($1,$2,$3,$4,$5)`, `membership-${suffix}`, tenantId, projectId, actorId, roleId);
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroProjectAuthorityEpoch" ("projectId","epoch","revision") VALUES ($1,7,0)`, projectId);
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroAuthorityCutover" ("projectId","aggregate","state","epoch","revision") VALUES ($1,'audit','LOCAL_PRIMARY',7,0)`, projectId);
    });
  });

  afterAll(async () => {
    await firstNonce.purgeForTest([projectId]);
    await firstDatabase.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroAuditEvent" WHERE "projectId"=$1`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroMembership" WHERE "projectId"=$1`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$1`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroAuthorityCutover" WHERE "projectId"=$1`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
    });
    await firstDatabase.$executeRawUnsafe(`DELETE FROM "BlroRole" WHERE "id"=$1`, roleId);
    await firstDatabase.$executeRawUnsafe(`DELETE FROM "BlroActor" WHERE "id"=$1`, actorId);
    await firstDatabase.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId);
    await Promise.all([firstDatabase.$disconnect(), secondDatabase.$disconnect()]);
  });

  it('Given one nonce and 32 simultaneous consumers, When both store instances reserve it, Then one wins and 31 are ALREADY_USED at the exact epoch', async () => {
    // Given
    const awaitRelease = barrier(32);
    const expiry = new Date(Date.now() + 60_000).toISOString();

    // When
    const outcomes = await Promise.all(Array.from({ length: 32 }, async (_, index) => {
      await awaitRelease();
      return (index % 2 === 0 ? firstNonce : secondNonce).consume(projectId, `nonce-${suffix}`, expiry, 7);
    }));

    // Then
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok && outcome.code === 'ALREADY_USED')).toHaveLength(31);
    const rows = await firstDatabase.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      return transaction.$queryRawUnsafe<Array<{ authorityEpoch: number }>>(`SELECT "authorityEpoch" FROM "BlroApprovalNonce" WHERE "nonce"=$1`, `nonce-${suffix}`);
    });
    expect(rows).toEqual([{ authorityEpoch: 7 }]);
  });

  it('Given two authority stores and 32 simultaneous appends, When all append, Then one contiguous keyed chain contains every unique event', async () => {
    // Given
    const awaitRelease = barrier(32);

    // When
    const events = await Promise.all(Array.from({ length: 32 }, async (_, index) => {
      await awaitRelease();
      return (index % 2 === 0 ? firstAuthority : secondAuthority).appendAudit({
        tenantId, projectId, actorId, kind: 'legacy.concurrent', payload: { index },
      });
    }));

    // Then
    expect(new Set(events.map((event) => event.hash)).size).toBe(32);
    const ordered = [...events].sort((left, right) => left.seq - right.seq);
    expect(ordered.map((event) => event.seq)).toEqual(Array.from({ length: 32 }, (_, index) => index));
    expect(new Set(ordered.map((event) => JSON.stringify(event.payload))).size).toBe(32);
    expect(verifyAuditEvents(ordered, auditSecret)).toEqual({ ok: true, keyed: true });
  });

  it('Given a nonce reservation session is terminated, When consume resolves, Then it returns STORE_UNAVAILABLE without local fallback', async () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), 'mandatory-nonce-outage-'));
    const victim = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    const control = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    const reservation = deferred<number>();
    const release = deferred<void>();
    const database = {
      $executeRawUnsafe: (query: string, ...values: unknown[]) => victim.$executeRawUnsafe(query, ...values),
      $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => victim.$queryRawUnsafe<T>(query, ...values),
      $transaction: async (work: (transaction: SqlExecutor) => Promise<unknown>): Promise<unknown> => victim.$transaction(async (transaction) => {
        const pid = await transaction.$queryRawUnsafe<Array<{ pid: number }>>(`SELECT pg_backend_pid() AS pid`);
        const wrapped: SqlExecutor = {
          $executeRawUnsafe: (query, ...values) => transaction.$executeRawUnsafe(query, ...values),
          $queryRawUnsafe: async <T>(query: string, ...values: unknown[]): Promise<T> => {
            if (query.includes('INSERT INTO "BlroApprovalNonce"')) {
              reservation.resolve(pid[0]?.pid ?? -1);
              await release.promise;
            }
            return transaction.$queryRawUnsafe<T>(query, ...values);
          },
        };
        return work(wrapped);
      }),
    };
    const store = new PostgresSingleUseNonceStore({ database });

    // When
    const consuming = store.consume(projectId, `outage-${suffix}`, new Date(Date.now() + 60_000).toISOString(), 7);
    const pid = await reservation.promise;
    await control.$executeRawUnsafe(`SELECT pg_terminate_backend($1::int)`, pid);
    release.resolve(undefined);
    const result = await consuming;

    // Then
    expect(result).toMatchObject({ ok: false, code: 'STORE_UNAVAILABLE' });
    expect(readdirSync(root)).toEqual([]);
    await Promise.all([victim.$disconnect(), control.$disconnect()]);
    rmSync(root, { recursive: true, force: true });
  });

  it('Given an audit append session is terminated after INSERT, When commit resolves, Then it is typed INDETERMINATE and recovery does not duplicate', async () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), 'mandatory-audit-outage-'));
    const victim = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    const control = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    const appended = deferred<number>();
    const release = deferred<void>();
    const database: AuthorityDatabase = {
      $executeRawUnsafe: (query, ...values) => victim.$executeRawUnsafe(query, ...values),
      $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => victim.$queryRawUnsafe<T>(query, ...values),
      $transaction: (work, options) => victim.$transaction(async (transaction) => {
        const pid = await transaction.$queryRawUnsafe<Array<{ pid: number }>>(`SELECT pg_backend_pid() AS pid`);
        const wrapped: SqlExecutor = {
          $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => transaction.$queryRawUnsafe<T>(query, ...values),
          $executeRawUnsafe: async (query, ...values) => {
            const result = await transaction.$executeRawUnsafe(query, ...values);
            if (query.includes('INSERT INTO "BlroAuditEvent"')) {
              appended.resolve(pid[0]?.pid ?? -1);
              await release.promise;
            }
            return result;
          },
        };
        return work(wrapped);
      }, options),
    };
    const store = new BlroAuthorityStore(database, auditSecret);

    // When
    const appending = store.appendAudit({ tenantId, projectId, actorId, kind: 'legacy.outage', payload: { outage: true } });
    const pid = await appended.promise;
    await control.$executeRawUnsafe(`SELECT pg_terminate_backend($1::int)`, pid);
    release.resolve(undefined);

    // Then
    await expect(appending).rejects.toBeInstanceOf(AuthorityStorePersistenceError);
    await expect(appending).rejects.toMatchObject({ code: 'INDETERMINATE' });
    await expect(firstAuthority.appendAudit({ tenantId, projectId, actorId, kind: 'legacy.recovered', payload: { recovered: true } })).resolves.toMatchObject({ seq: 32 });
    expect(readdirSync(root)).toEqual([]);
    await Promise.all([victim.$disconnect(), control.$disconnect()]);
    rmSync(root, { recursive: true, force: true });
  });
});
