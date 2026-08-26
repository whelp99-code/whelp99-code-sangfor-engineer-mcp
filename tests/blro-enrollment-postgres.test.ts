import { X509Certificate, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_BOOTSTRAP_TTL_MS,
  PostgresEnrollmentRegistry,
} from '../packages/sangfor-browser-contracts/src/enrollment.js';
import {
  createTaskCertificateFixture,
  type TaskCertificateFixture,
} from './helpers/blro-certificate-fixture.js';

const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.BLRO_OWNER_DATABASE_URL;
const describeDb = DATABASE_URL && OWNER_URL ? describe : describe.skip;
const suffix = randomUUID();
const tenantId = `enrollment-tenant-${suffix}`;
const projectId = `enrollment-project-${suffix}`;
const installationId = `enrollment-install-${suffix}`;
const deviceBindingDigest = 'd'.repeat(64);
const originDigest = 'a'.repeat(64);
const tokenDigest = 'b'.repeat(64);
const mutableClock = { value: new Date('2026-08-26T12:00:00.000Z') };
let owner: PrismaClient;
let database: PrismaClient;
let registry: PostgresEnrollmentRegistry;
let root: string;
let certificates: TaskCertificateFixture;

const binding = () => ({ tenantId, projectId, installationId, deviceBindingDigest });
const leaf = (value: string) => ({ encoding: 'pem' as const, value });
const serial = (pem: string): string => new X509Certificate(pem).serialNumber;
const grant = () => ({ originDigest, scope: 'browser:execute' });
const presentation = (pem: string) => ({ ...binding(), ...grant(), certificate: leaf(pem) });

async function clearEnrollmentRows(): Promise<void> {
  await owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
    for (const table of [
      'BlroEnrollmentRotation', 'BlroEnrollmentGrant', 'BlroEnrollmentCertificate',
      'BlroEnrollmentIdentity', 'BlroEnrollmentBootstrapToken',
    ]) await transaction.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId"=$1`, projectId);
  });
}

async function issueAndClaim(pem = certificates.validPem): Promise<void> {
  await registry.issueBootstrapToken({
    ...binding(), tokenDigest, expiresAt: new Date(mutableClock.value.getTime() + 60_000).toISOString(),
    grants: [grant()],
  });
  const claimed = await registry.claimBootstrapToken({
    ...binding(), tokenDigest, clientIdentityId: `client:${installationId}`, certificate: leaf(pem),
  });
  expect(claimed).toMatchObject({ ok: true, enrollment: { revision: 1 } });
}

describeDb('BLRO enrollment registry on PostgreSQL', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'task21-postgres-x509-'));
    certificates = createTaskCertificateFixture(root, installationId, deviceBindingDigest);
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    database = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    await owner.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2)`, tenantId, 'Task 21');
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`,
        projectId, tenantId, 'Task 21 project',
      );
    });
    registry = new PostgresEnrollmentRegistry({
      database, scope: { tenantId, projectId }, clock: { now: () => mutableClock.value },
      trustedIssuerBundle: certificates.trustedCaPem,
    });
  });
  beforeEach(async () => {
    mutableClock.value = new Date('2026-08-26T12:00:00.000Z');
    await clearEnrollmentRows();
  });
  afterAll(async () => {
    await clearEnrollmentRows();
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
    });
    await owner.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId);
    await Promise.all([database.$disconnect(), owner.$disconnect()]);
    rmSync(root, { recursive: true, force: true });
  });

  it('claims a digest exactly once under 32 concurrent signed-certificate enrollments', async () => {
    await registry.issueBootstrapToken({
      ...binding(), tokenDigest, expiresAt: '2026-08-26T12:05:00.000Z', grants: [grant()],
    });
    const claims = await Promise.all(Array.from({ length: 32 }, () => registry.claimBootstrapToken({
      ...binding(), tokenDigest, clientIdentityId: `client:${installationId}`,
      certificate: leaf(certificates.validPem),
    })));

    expect(claims.filter(({ ok }) => ok)).toHaveLength(1);
    expect(claims.filter((result) => !result.ok && result.reason === 'TOKEN_REPLAYED')).toHaveLength(31);
    const stored = await owner.$queryRawUnsafe<readonly { readonly source: string }[]>(
      `SELECT coalesce(string_agg(row_to_json(t)::text,''),'') source FROM "BlroEnrollmentCertificate" t`,
    );
    expect(stored[0]?.source).not.toContain('BEGIN CERTIFICATE');
  });

  it('derives authorization identity and keeps only middle plus newest after three certificates', async () => {
    await issueAndClaim();
    await expect(registry.rotate({
      ...binding(), expectedRevision: 1, certificate: leaf(certificates.middlePem),
      overlapExpiresAt: '2026-08-26T12:10:00.000Z',
    })).resolves.toMatchObject({ ok: true, enrollment: { revision: 2 } });
    const newestRotation = await registry.rotate({
      ...binding(), expectedRevision: 2, certificate: leaf(certificates.newestPem),
      overlapExpiresAt: '2026-08-26T12:10:00.000Z',
    });
    expect(newestRotation).toMatchObject({ ok: true, enrollment: { revision: 3 } });
    await expect(registry.authorize(presentation(certificates.validPem)))
      .resolves.toMatchObject({ ok: false, reason: 'CERTIFICATE_REVOKED' });
    await expect(registry.authorize(presentation(certificates.middlePem))).resolves.toEqual({ ok: true, revision: 3 });
    await expect(registry.authorize(presentation(certificates.newestPem))).resolves.toEqual({ ok: true, revision: 3 });
    await expect(registry.authorize({
      ...presentation(certificates.newestPem), originDigest: 'f'.repeat(64),
    })).resolves.toEqual({ ok: false, reason: 'ORIGIN_NOT_GRANTED' });
    await expect(registry.authorize({
      ...presentation(certificates.newestPem), scope: 'browser:admin',
    })).resolves.toEqual({ ok: false, reason: 'SCOPE_NOT_GRANTED' });
    const authorized = await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      return transaction.$queryRawUnsafe<readonly { readonly count: number }[]>(
        `SELECT count(*)::int count FROM "BlroEnrollmentCertificate" WHERE "state" IN ('active','overlap')`,
      );
    });
    expect(authorized[0]?.count).toBe(2);

    const exactRetry = {
      ...binding(), expectedRevision: 2, certificate: leaf(certificates.newestPem),
      overlapExpiresAt: '2026-08-26T12:10:00.000Z',
    };
    await expect(registry.rotate(exactRetry)).resolves.toEqual(newestRotation);
    await expect(registry.rotate({ ...exactRetry, certificate: leaf(certificates.changedSerialPem) }))
      .resolves.toMatchObject({ ok: false, reason: 'REVISION_CONFLICT' });
    await expect(registry.rotate({ ...exactRetry, overlapExpiresAt: '2026-08-26T12:11:00.000Z' }))
      .resolves.toMatchObject({ ok: false, reason: 'REVISION_CONFLICT' });

    const acknowledgement = {
      ...binding(), expectedRevision: 3,
      oldSerial: serial(certificates.middlePem), newSerial: serial(certificates.newestPem),
    };
    const acknowledged = await registry.acknowledgeRotation(acknowledgement);
    expect(acknowledged).toMatchObject({ ok: true, enrollment: { revision: 4 } });
    await expect(registry.acknowledgeRotation({ ...acknowledgement, oldSerial: serial(certificates.validPem) }))
      .resolves.toMatchObject({ ok: false });
    await expect(registry.acknowledgeRotation(acknowledgement)).resolves.toEqual(acknowledged);
  });

  it.each([
    ['foreign', () => certificates.foreignPem, 'ISSUER_UNTRUSTED'],
    ['unsigned', () => certificates.unsignedPem, 'ISSUER_UNTRUSTED'],
    ['CN only', () => certificates.cnOnlyPem, 'SAN_MISMATCH'],
    ['wrong EKU', () => certificates.wrongEkuPem, 'CLIENT_EKU_MISSING'],
    ['expired', () => certificates.expiredPem, 'CERTIFICATE_EXPIRED'],
    ['future', () => certificates.futurePem, 'CERTIFICATE_NOT_YET_VALID'],
  ] as const)('refuses %s leaf certificates before stored identity can be mimicked', async (_case, pem, reason) => {
    await issueAndClaim();
    await expect(registry.authorize(presentation(pem()))).resolves.toEqual({ ok: false, reason });
  });

  it('enforces the 15-minute bootstrap TTL including equality and a 2036 expiry', async () => {
    expect(MAX_BOOTSTRAP_TTL_MS).toBe(900_000);
    await expect(registry.issueBootstrapToken({
      ...binding(), tokenDigest, expiresAt: new Date(mutableClock.value.getTime() + MAX_BOOTSTRAP_TTL_MS).toISOString(),
      grants: [grant()],
    })).resolves.toMatchObject({ ok: true });
    await clearEnrollmentRows();
    await expect(registry.issueBootstrapToken({
      ...binding(), tokenDigest, expiresAt: new Date(mutableClock.value.getTime() + MAX_BOOTSTRAP_TTL_MS + 1).toISOString(),
      grants: [grant()],
    })).resolves.toEqual({ ok: false, reason: 'TOKEN_TTL_EXCEEDED' });
    await expect(registry.issueBootstrapToken({
      ...binding(), tokenDigest: '9'.repeat(64), expiresAt: '2036-01-01T00:00:00.000Z', grants: [grant()],
    })).resolves.toEqual({ ok: false, reason: 'TOKEN_TTL_EXCEEDED' });
    await expect(registry.issueBootstrapToken({
      ...binding(), tokenDigest: '8'.repeat(64), expiresAt: mutableClock.value.toISOString(), grants: [grant()],
    })).resolves.toEqual({ ok: false, reason: 'TOKEN_EXPIRED' });
    await registry.issueBootstrapToken({
      ...binding(), tokenDigest: '7'.repeat(64),
      expiresAt: new Date(mutableClock.value.getTime() + 1).toISOString(), grants: [grant()],
    });
    mutableClock.value = new Date(mutableClock.value.getTime() + 1);
    await expect(registry.claimBootstrapToken({
      ...binding(), tokenDigest: '7'.repeat(64), clientIdentityId: `client:${installationId}`,
      certificate: leaf(certificates.validPem),
    })).resolves.toEqual({ ok: false, reason: 'TOKEN_EXPIRED' });
  });

  it('orders revocation before and after rotation deterministically', async () => {
    await issueAndClaim();
    await registry.revoke({ ...binding(), expectedRevision: 1, reason: 'revoke first' });
    await expect(registry.rotate({
      ...binding(), expectedRevision: 2, certificate: leaf(certificates.middlePem),
      overlapExpiresAt: '2026-08-26T12:10:00.000Z',
    })).resolves.toMatchObject({ ok: false, reason: 'ENROLLMENT_REVOKED' });
    await clearEnrollmentRows();
    await issueAndClaim();
    await registry.rotate({
      ...binding(), expectedRevision: 1, certificate: leaf(certificates.middlePem),
      overlapExpiresAt: '2026-08-26T12:10:00.000Z',
    });
    await expect(registry.revoke({ ...binding(), expectedRevision: 2, reason: 'revoke new' }))
      .resolves.toMatchObject({ ok: true, enrollment: { state: 'revoked', revision: 3 } });
  });
});
