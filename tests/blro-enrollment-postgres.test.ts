import { X509Certificate, createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_BOOTSTRAP_TTL_MS,
  MAX_ROTATION_OVERLAP_MS,
  PostgresEnrollmentRegistry,
  deriveClientCertificateIdentity,
} from '../packages/sangfor-authority/src/index.js';
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
const bootstrapToken = 'raw-bootstrap-token-32-bytes-minimum-AAAAAA';
const tokenDigest = createHash('sha256').update(bootstrapToken).digest('hex');
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

async function scopedRows<T>(query: string, ...values: readonly unknown[]): Promise<readonly T[]> {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
    return transaction.$queryRawUnsafe<readonly T[]>(query, ...values);
  });
}

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
    ...binding(), bootstrapToken, clientIdentityId: `client:${installationId}`, certificate: leaf(pem),
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

  it('preflights token state before certificate derivation without consuming a valid token', async () => {
    const derivations: string[] = [];
    const orderedRegistry = new PostgresEnrollmentRegistry({
      database, scope: { tenantId, projectId }, clock: { now: () => mutableClock.value },
      trustedIssuerBundle: certificates.trustedCaPem,
      certificateIdentityDeriver: (input) => {
        derivations.push(input.certificate.value);
        return deriveClientCertificateIdentity(input);
      },
    });
    const validToken = 'valid-preflight-bootstrap-token-32-bytes-AAAAAA';
    const expiredToken = 'expired-preflight-bootstrap-token-32-bytes-AAAA';
    await orderedRegistry.issueBootstrapToken({
      ...binding(), tokenDigest: createHash('sha256').update(validToken).digest('hex'),
      expiresAt: new Date(mutableClock.value.getTime() + 60_000).toISOString(), grants: [grant()],
    });
    await orderedRegistry.issueBootstrapToken({
      ...binding(), tokenDigest: createHash('sha256').update(expiredToken).digest('hex'),
      expiresAt: new Date(mutableClock.value.getTime() + 1).toISOString(), grants: [grant()],
    });
    const foreignProjectId = `foreign-${projectId}`;
    const crossProjectToken = 'cross-project-bootstrap-token-32-bytes-AAAAAA';
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, foreignProjectId);
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`,
        foreignProjectId, tenantId, 'Foreign Task 21 project',
      );
    });
    const foreignRegistry = new PostgresEnrollmentRegistry({
      database, scope: { tenantId, projectId: foreignProjectId }, clock: { now: () => mutableClock.value },
      trustedIssuerBundle: certificates.trustedCaPem,
    });
    await foreignRegistry.issueBootstrapToken({
      ...binding(), projectId: foreignProjectId,
      tokenDigest: createHash('sha256').update(crossProjectToken).digest('hex'),
      expiresAt: new Date(mutableClock.value.getTime() + 60_000).toISOString(), grants: [grant()],
    });
    const claim = (rawToken: string, pem = certificates.foreignPem) => ({
      ...binding(), bootstrapToken: rawToken, clientIdentityId: `client:${installationId}`, certificate: leaf(pem),
    });
    try {
      await expect(orderedRegistry.claimBootstrapToken(claim('nonexistent-bootstrap-token-32-bytes-AAAAAA')))
        .resolves.toEqual({ ok: false, reason: 'TOKEN_INVALID' });
      await expect(orderedRegistry.claimBootstrapToken(claim(crossProjectToken)))
        .resolves.toEqual({ ok: false, reason: 'TOKEN_INVALID' });
      await expect(orderedRegistry.claimBootstrapToken({
        ...claim(validToken), installationId: `wrong-${installationId}`,
      })).resolves.toEqual({ ok: false, reason: 'TOKEN_INVALID' });
      await expect(orderedRegistry.claimBootstrapToken({
        ...claim(validToken), deviceBindingDigest: 'e'.repeat(64),
      })).resolves.toEqual({ ok: false, reason: 'TOKEN_INVALID' });
      mutableClock.value = new Date(mutableClock.value.getTime() + 1);
      await expect(orderedRegistry.claimBootstrapToken(claim(expiredToken)))
        .resolves.toEqual({ ok: false, reason: 'TOKEN_EXPIRED' });
      expect(derivations).toHaveLength(0);
      expect(await scopedRows<{ readonly count: number }>(
        `SELECT count(*)::int count FROM "BlroEnrollmentIdentity"`,
      )).toEqual([{ count: 0 }]);

      await expect(orderedRegistry.claimBootstrapToken(claim(validToken)))
        .resolves.toEqual({ ok: false, reason: 'ISSUER_UNTRUSTED' });
      expect(derivations).toHaveLength(1);
      expect(await scopedRows<{ readonly claimedAt: Date | null }>(
        `SELECT "claimedAt" FROM "BlroEnrollmentBootstrapToken" WHERE "tokenDigest"=$1`,
        createHash('sha256').update(validToken).digest('hex'),
      )).toEqual([{ claimedAt: null }]);
      await expect(orderedRegistry.claimBootstrapToken(claim(validToken, certificates.validPem)))
        .resolves.toMatchObject({ ok: true, enrollment: { revision: 1 } });
      expect(derivations).toHaveLength(2);
      await expect(orderedRegistry.claimBootstrapToken(claim(validToken)))
        .resolves.toEqual({ ok: false, reason: 'TOKEN_REPLAYED' });
      expect(derivations).toHaveLength(2);
    } finally {
      await owner.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, foreignProjectId);
        await transaction.$executeRawUnsafe(
          `DELETE FROM "BlroEnrollmentBootstrapToken" WHERE "projectId"=$1`, foreignProjectId,
        );
        await transaction.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, foreignProjectId);
      });
    }
  });

  it('claims a digest exactly once under 32 concurrent signed-certificate enrollments', async () => {
    await registry.issueBootstrapToken({
      ...binding(), tokenDigest, expiresAt: '2026-08-26T12:05:00.000Z', grants: [grant()],
    });
    await expect(registry.claimBootstrapToken({
      ...binding(), bootstrapToken: tokenDigest, clientIdentityId: `client:${installationId}`,
      certificate: leaf(certificates.validPem),
    })).resolves.toEqual({ ok: false, reason: 'TOKEN_INVALID' });
    const claims = await Promise.all(Array.from({ length: 32 }, () => registry.claimBootstrapToken({
      ...binding(), bootstrapToken, clientIdentityId: `client:${installationId}`,
      certificate: leaf(certificates.validPem),
    })));

    expect(claims.filter(({ ok }) => ok)).toHaveLength(1);
    expect(claims.filter((result) => !result.ok && result.reason === 'TOKEN_REPLAYED')).toHaveLength(31);
    const stored = await owner.$queryRawUnsafe<readonly { readonly source: string }[]>(
      `SELECT coalesce(string_agg(row_to_json(t)::text,''),'') source FROM "BlroEnrollmentCertificate" t`,
    );
    expect(stored[0]?.source).not.toContain('BEGIN CERTIFICATE');
  });

  it('refuses duplicate installation enrollment and cross-project authorization', async () => {
    await issueAndClaim();
    const duplicateToken = 'duplicate-bootstrap-token-32-bytes-minimum-A';
    const duplicateDigest = createHash('sha256').update(duplicateToken).digest('hex');
    await registry.issueBootstrapToken({
      ...binding(), tokenDigest: duplicateDigest, expiresAt: '2026-08-26T12:05:00.000Z', grants: [grant()],
    });
    await expect(registry.claimBootstrapToken({
      ...binding(), bootstrapToken: duplicateToken,
      clientIdentityId: `client:duplicate:${installationId}`, certificate: leaf(certificates.middlePem),
    })).resolves.toEqual({ ok: false, reason: 'ENROLLMENT_EXISTS' });
    await expect(registry.authorize({
      ...presentation(certificates.validPem), projectId: `foreign-${projectId}`,
    })).resolves.toEqual({ ok: false, reason: 'ENROLLMENT_MISSING' });
  });

  it('derives authorization identity and keeps only middle plus newest after three certificates', async () => {
    await issueAndClaim();
    expect(MAX_ROTATION_OVERLAP_MS).toBe(600_000);
    await expect(registry.rotate({
      ...binding(), expectedRevision: 1, certificate: leaf(certificates.middlePem),
      overlapExpiresAt: new Date(mutableClock.value.getTime() + MAX_ROTATION_OVERLAP_MS + 1).toISOString(),
    })).resolves.toEqual({ ok: false, reason: 'ROTATION_INVALID' });
    await expect(registry.rotate({
      ...binding(), expectedRevision: 1, certificate: leaf(certificates.middlePem),
      overlapExpiresAt: '2036-01-01T00:00:00.000Z',
    })).resolves.toEqual({ ok: false, reason: 'ROTATION_INVALID' });
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
      return transaction.$queryRawUnsafe<readonly { readonly authorized: number; readonly active: number }[]>(
        `SELECT count(*) FILTER (WHERE "state" IN ('active','overlap'))::int authorized,
          count(*) FILTER (WHERE "state"='active')::int active FROM "BlroEnrollmentCertificate"`,
      );
    });
    expect(authorized[0]).toEqual({ authorized: 2, active: 1 });

    const exactRetry = {
      ...binding(), expectedRevision: 2, certificate: leaf(certificates.newestPem),
      overlapExpiresAt: '2026-08-26T12:10:00.000Z',
    };
    await expect(registry.rotate(exactRetry)).resolves.toEqual(newestRotation);
    await expect(registry.rotate({ ...exactRetry, certificate: leaf(certificates.changedSerialPem) }))
      .resolves.toMatchObject({ ok: false, reason: 'REVISION_CONFLICT' });
    await expect(registry.rotate({ ...exactRetry, overlapExpiresAt: '2026-08-26T12:09:00.000Z' }))
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

  it('enforces the 10-minute bootstrap TTL including equality and a 2036 expiry', async () => {
    expect(MAX_BOOTSTRAP_TTL_MS).toBe(600_000);
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
    const expiryToken = 'expiry-bootstrap-token-32-bytes-minimum-AAAA';
    await registry.issueBootstrapToken({
      ...binding(), tokenDigest: createHash('sha256').update(expiryToken).digest('hex'),
      expiresAt: new Date(mutableClock.value.getTime() + 1).toISOString(), grants: [grant()],
    });
    mutableClock.value = new Date(mutableClock.value.getTime() + 1);
    await expect(registry.claimBootstrapToken({
      ...binding(), bootstrapToken: expiryToken,
      clientIdentityId: `client:${installationId}`, certificate: leaf(certificates.validPem),
    })).resolves.toEqual({ ok: false, reason: 'TOKEN_EXPIRED' });
  });

  it('orders revocation before and after rotation deterministically', async () => {
    await issueAndClaim();
    const revokedFirst = await registry.revoke({ ...binding(), expectedRevision: 1, reason: 'revoke first' });
    expect(revokedFirst).toMatchObject({ ok: true, enrollment: { state: 'revoked' } });
    if (revokedFirst.ok) {
      expect(Date.parse(revokedFirst.enrollment.revokedAt ?? '') - mutableClock.value.getTime()).toBeLessThan(60_000);
    }
    await expect(registry.authorize(presentation(certificates.validPem)))
      .resolves.toEqual({ ok: false, reason: 'ENROLLMENT_REVOKED' });
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
    await expect(registry.authorize(presentation(certificates.middlePem)))
      .resolves.toEqual({ ok: false, reason: 'ENROLLMENT_REVOKED' });
  });
});
