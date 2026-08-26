import { X509Certificate, createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthorityRuntime, type AuthorityRuntimeEnvironment } from '../apps/control-tower/src/authority-runtime.js';
import { createTowerServer } from '../apps/control-tower/src/server.js';
import {
  createTaskCertificateFixture,
  type TaskCertificateFixture,
} from './helpers/blro-certificate-fixture.js';

const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.BLRO_OWNER_DATABASE_URL;
const describeDb = DATABASE_URL && OWNER_URL ? describe : describe.skip;
const suffix = randomUUID();
const tenantId = `http-enrollment-tenant-${suffix}`;
const projectId = `http-enrollment-project-${suffix}`;
const installationId = `http-enrollment-install-${suffix}`;
const deviceBindingDigest = 'd'.repeat(64);
const originDigest = 'a'.repeat(64);
const bearer = 'task21-http-route-token';
let root: string;
let owner: PrismaClient;
let application: PrismaClient;
let runtime: ReturnType<typeof createAuthorityRuntime>;
let server: ReturnType<typeof createTowerServer>;
let baseUrl: string;
let certificates: TaskCertificateFixture;

const binding = () => ({ tenantId, projectId, installationId, deviceBindingDigest });
const leaf = (value: string) => ({ encoding: 'pem' as const, value });
async function request(
  path: string,
  method: 'GET' | 'POST',
  body?: Readonly<Record<string, unknown>>,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const parsed: unknown = await response.json();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Expected JSON object.');
  return { status: response.status, body: Object.fromEntries(Object.entries(parsed)) };
}

async function scopedRows<T>(query: string, ...values: readonly unknown[]): Promise<readonly T[]> {
  return application.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
    return transaction.$queryRawUnsafe<readonly T[]>(query, ...values);
  });
}

describeDb('Control Tower enrollment HTTP routes on PostgreSQL', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'task21-http-enrollment-'));
    certificates = createTaskCertificateFixture(join(root, 'certificates'), installationId, deviceBindingDigest);
    const signingPath = join(root, 'signing.key');
    const trustPath = join(root, 'trust.crt');
    writeFileSync(signingPath, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    writeFileSync(trustPath, certificates.trustedCaPem);
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    application = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    await owner.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2)`, tenantId, 'HTTP enrollment');
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`,
        projectId, tenantId, 'HTTP enrollment',
      );
    });
    const environment: AuthorityRuntimeEnvironment = {
      SANGFOR_BLRO_AUTHORITY_STORE: 'postgres', DATABASE_URL,
      SANGFOR_TENANT_ID: tenantId, SANGFOR_PROJECT_ID: projectId,
      SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH: signingPath, SANGFOR_BLRO_TRUST_BUNDLE_PATH: trustPath,
      SANGFOR_BLRO_AUDIT_SECRET: 'a'.repeat(32), SANGFOR_OPERATOR_APPROVAL_SECRET: 'o'.repeat(32),
    };
    runtime = createAuthorityRuntime({ environment });
    await runtime.start();
    server = createTowerServer({ authorityRuntime: runtime, apiToken: bearer });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new TypeError('Expected HTTP address.');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.close();
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      for (const table of [
        'BlroEnrollmentRotation', 'BlroEnrollmentGrant', 'BlroEnrollmentCertificate',
        'BlroEnrollmentIdentity', 'BlroEnrollmentBootstrapToken',
      ]) await transaction.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId"=$1`, projectId);
      await transaction.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
    });
    await owner.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId);
    await Promise.all([application.$disconnect(), owner.$disconnect()]);
    rmSync(root, { recursive: true, force: true });
  });

  it('issues a raw credential once and drives the persisted certificate lifecycle', async () => {
    const expiredIssue = await request('/api/enrollments/bootstrap-tokens', 'POST', {
      ...binding(), expiresAt: new Date(Date.now() - 1).toISOString(),
      grants: [{ originDigest, scope: 'browser:execute' }],
    });
    expect(expiredIssue).toEqual({ status: 410, body: { ok: false, reason: 'TOKEN_EXPIRED' } });
    expect(expiredIssue.body).not.toHaveProperty('bootstrapToken');
    const issued = await request('/api/enrollments/bootstrap-tokens', 'POST', {
      ...binding(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
      grants: [{ originDigest, scope: 'browser:execute' }],
    });
    expect(issued).toMatchObject({ status: 200, body: { ok: true } });
    const bootstrapToken = issued.body['bootstrapToken'];
    expect(typeof bootstrapToken).toBe('string');
    if (typeof bootstrapToken !== 'string') return;
    expect(bootstrapToken).toMatch(/^[A-Za-z0-9_-]{43,}$/u);
    const tokens = await scopedRows<{ readonly tokenDigest: string; readonly claimedAt: Date | null }>(
      `SELECT "tokenDigest","claimedAt" FROM "BlroEnrollmentBootstrapToken"`,
    );
    const digest = createHash('sha256').update(bootstrapToken).digest('hex');
    expect(tokens).toEqual([{ tokenDigest: digest, claimedAt: null }]);
    expect(JSON.stringify(tokens)).not.toContain(bootstrapToken);

    const claim = (credential: string, certificate = certificates.validPem) => ({
      ...binding(), bootstrapToken: credential, clientIdentityId: `client:${installationId}`,
      certificate: leaf(certificate),
    });
    const digestClaim = await request('/api/enrollments/bootstrap', 'POST', claim(digest));
    expect(digestClaim).toEqual({ status: 404, body: { ok: false, reason: 'TOKEN_INVALID' } });
    const nonexistent = await request('/api/enrollments/bootstrap', 'POST', claim(
      'nonexistent-http-bootstrap-token-32-bytes-AAAAAA', certificates.foreignPem,
    ));
    expect(nonexistent).toEqual({ status: 404, body: { ok: false, reason: 'TOKEN_INVALID' } });
    const expiringIssue = await request('/api/enrollments/bootstrap-tokens', 'POST', {
      ...binding(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
      grants: [{ originDigest, scope: 'browser:execute' }],
    });
    const expiringToken = expiringIssue.body['bootstrapToken'];
    expect(typeof expiringToken).toBe('string');
    if (typeof expiringToken !== 'string') return;
    const expiringDigest = createHash('sha256').update(expiringToken).digest('hex');
    await application.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await transaction.$executeRawUnsafe(
        `UPDATE "BlroEnrollmentBootstrapToken" SET "expiresAt"=current_timestamp WHERE "tokenDigest"=$1`,
        expiringDigest,
      );
    });
    const expiredClaim = await request('/api/enrollments/bootstrap', 'POST', claim(
      expiringToken, certificates.foreignPem,
    ));
    expect(expiredClaim).toEqual({ status: 410, body: { ok: false, reason: 'TOKEN_EXPIRED' } });
    expect(JSON.stringify(expiredClaim)).not.toContain(expiringToken);
    const foreign = await request('/api/enrollments/bootstrap', 'POST', claim(bootstrapToken, certificates.foreignPem));
    expect(foreign).toEqual({ status: 403, body: { ok: false, reason: 'ISSUER_UNTRUSTED' } });
    const secret = await request('/api/enrollments/bootstrap', 'POST', {
      ...claim(bootstrapToken), privateKey: 'must-not-cross',
    });
    expect(secret.status).toBe(400);
    const crossProject = await request('/api/enrollments/bootstrap', 'POST', {
      ...claim(bootstrapToken), projectId: `foreign-${projectId}`,
    });
    expect(crossProject).toEqual({ status: 403, body: { ok: false, reason: 'BINDING_MISMATCH' } });
    expect(await scopedRows<{ readonly claimedAt: Date | null }>(
      `SELECT "claimedAt" FROM "BlroEnrollmentBootstrapToken" WHERE "tokenDigest"=$1`, digest,
    )).toEqual([{ claimedAt: null }]);
    expect(await scopedRows<{ readonly count: number }>(
      `SELECT count(*)::int count FROM "BlroEnrollmentIdentity"`,
    )).toEqual([{ count: 0 }]);

    expect(await request('/api/enrollments/bootstrap', 'POST', claim(bootstrapToken)))
      .toMatchObject({ status: 200, body: { ok: true } });
    const replay = await request(
      '/api/enrollments/bootstrap', 'POST', claim(bootstrapToken, certificates.foreignPem),
    );
    expect(replay).toEqual({ status: 409, body: { ok: false, reason: 'TOKEN_REPLAYED' } });
    expect(JSON.stringify(replay)).not.toContain(bootstrapToken);
    const read = await request(`/api/enrollments/${installationId}`, 'GET');
    expect(read).toMatchObject({ status: 200, body: { revision: 1, installationId } });
    expect(JSON.stringify(read)).not.toContain(bootstrapToken);

    const wrongPath = await request('/api/enrollments/another-installation/rotate', 'POST', {
      ...binding(), expectedRevision: 1, certificate: leaf(certificates.middlePem),
      overlapExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    expect(wrongPath).toEqual({ status: 400, body: { error: 'INVALID_ENROLLMENT_REQUEST' } });
    const rotated = await request(`/api/enrollments/${installationId}/rotate`, 'POST', {
      ...binding(), expectedRevision: 1, certificate: leaf(certificates.middlePem),
      overlapExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    expect(rotated).toMatchObject({ status: 200, body: { ok: true, enrollment: { revision: 2 } } });
    const acknowledged = await request(`/api/enrollments/${installationId}/acknowledge`, 'POST', {
      ...binding(), expectedRevision: 2,
      oldSerial: new X509Certificate(certificates.validPem).serialNumber,
      newSerial: new X509Certificate(certificates.middlePem).serialNumber,
    });
    expect(acknowledged).toMatchObject({ status: 200, body: { ok: true, enrollment: { revision: 3 } } });
    const revoked = await request(`/api/enrollments/${installationId}/revoke`, 'POST', {
      ...binding(), expectedRevision: 3, reason: 'HTTP lifecycle complete',
    });
    expect(revoked).toMatchObject({ status: 200, body: { ok: true, enrollment: { state: 'revoked' } } });
    const finalRead = await request(`/api/enrollments/${installationId}`, 'GET');
    expect(finalRead).toMatchObject({ status: 200, body: { state: 'revoked', revision: 4 } });
    expect(JSON.stringify(finalRead)).not.toContain(bootstrapToken);
  });
});
