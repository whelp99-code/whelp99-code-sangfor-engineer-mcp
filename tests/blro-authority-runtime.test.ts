import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BLRO_RUNTIME_SCHEMA_VERSION,
  createAuthorityRuntime,
  type AuthorityRuntimeEnvironment,
} from '../apps/control-tower/src/authority-runtime.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://blro_app:blro_app_local@127.0.0.1:55432/blro';
const OWNER_URL = 'postgresql://blro_owner:blro_owner_local@127.0.0.1:55432/blro';
const PROJECT_ID = 'task19-project';
const TENANT_ID = 'task19-tenant';
let materialRoot: string;
let signingPrivateKeyPath: string;
let trustBundlePath: string;

const completeEnvironment = (): AuthorityRuntimeEnvironment => ({
  SANGFOR_BLRO_AUTHORITY_STORE: 'postgres',
  DATABASE_URL,
  SANGFOR_TENANT_ID: TENANT_ID,
  SANGFOR_PROJECT_ID: PROJECT_ID,
  SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH: signingPrivateKeyPath,
  SANGFOR_BLRO_TRUST_BUNDLE_PATH: trustBundlePath,
  SANGFOR_BLRO_AUDIT_SECRET: 'a'.repeat(32),
  SANGFOR_OPERATOR_APPROVAL_SECRET: 'o'.repeat(32),
});

let owner: PrismaClient;

beforeAll(async () => {
  materialRoot = mkdtempSync(join(tmpdir(), 'task19-material-'));
  signingPrivateKeyPath = join(materialRoot, 'signing.key');
  trustBundlePath = join(materialRoot, 'ca.crt');
  writeFileSync(signingPrivateKeyPath, generateKeyPairSync('ed25519').privateKey.export({
    format: 'pem', type: 'pkcs8',
  }), { mode: 0o600 });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=task19-ca', '-keyout', join(materialRoot, 'ca.key'),
    '-out', trustBundlePath,
  ], { stdio: 'pipe' });
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.$executeRawUnsafe(
    `INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2) ON CONFLICT ("id") DO NOTHING`,
    TENANT_ID,
    'Task 19 tenant',
  );
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, PROJECT_ID);
    await tx.$executeRawUnsafe(
      `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3) ON CONFLICT ("id") DO NOTHING`,
      PROJECT_ID,
      TENANT_ID,
      'Task 19 project',
    );
  });
});

afterAll(async () => {
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, PROJECT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM "BlroBrowserJobResult" WHERE "projectId"=$1`, PROJECT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM "BlroClientEnrollment" WHERE "projectId"=$1`, PROJECT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, PROJECT_ID);
  });
  await owner.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, TENANT_ID);
  await owner.$disconnect();
  rmSync(materialRoot, { recursive: true, force: true });
});

describe('BLRO authority runtime composition', () => {
  it('does not construct resources when configuration is incomplete or malformed', async () => {
    const runtime = createAuthorityRuntime({
      environment: { ...completeEnvironment(), DATABASE_URL: 'file:authority.db', SANGFOR_BLRO_TRUST_BUNDLE_PATH: undefined },
    });

    await runtime.start();

    expect(runtime.resources()).toBeUndefined();
    await expect(runtime.readiness()).resolves.toMatchObject({
      ok: false,
      checks: { config: { ok: false }, database: { ok: false }, trust: { ok: false } },
    });
    expect(runtime.liveness()).toEqual({ ok: true, state: 'running' });
  });

  it('reports corrupt signing and trust material without opening the database or falling back', async () => {
    const corruptSigning = join(materialRoot, 'corrupt-signing.key');
    const corruptTrust = join(materialRoot, 'corrupt-trust.crt');
    writeFileSync(corruptSigning, 'not-a-private-key', { mode: 0o600 });
    writeFileSync(corruptTrust, 'not-a-ca-certificate', { mode: 0o600 });
    const runtime = createAuthorityRuntime({
      environment: {
        ...completeEnvironment(),
        SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH: corruptSigning,
        SANGFOR_BLRO_TRUST_BUNDLE_PATH: corruptTrust,
      },
    });

    await runtime.start();

    await expect(runtime.readiness()).resolves.toMatchObject({
      ok: false,
      checks: { signing: { ok: false }, trust: { ok: false }, database: { ok: false } },
    });
    expect(runtime.resources()).toBeUndefined();
    await runtime.close();
  });

  it('constructs every authority dependency only after config, database, schema, signing, trust, and scope pass', async () => {
    const runtime = createAuthorityRuntime({ environment: completeEnvironment() });

    await runtime.start();

    await expect(runtime.readiness()).resolves.toMatchObject({
      ok: true,
      schemaVersion: BLRO_RUNTIME_SCHEMA_VERSION,
      checks: {
        config: { ok: true }, database: { ok: true }, schema: { ok: true },
        signing: { ok: true }, trust: { ok: true }, scope: { ok: true },
      },
    });
    expect(runtime.resources()).toMatchObject({
      authorityStore: expect.any(Object), nonceStore: expect.any(Object),
      enrollmentStore: expect.any(Object), jobStore: expect.any(Object),
      domainApis: expect.any(Object),
    });
    const stores = runtime.resources();
    if (!stores) throw new Error('authority resources missing');
    const enrollment = {
      schemaVersion: 'browser-enrollment.v1' as const,
      installationId: 'task19-installation', clientIdentityId: 'client:task19-installation',
      certificateSerial: 'task19-serial', publicKeyFingerprintSha256: 'a'.repeat(64),
      certificateFingerprintSha256: 'b'.repeat(64), status: 'active' as const,
      enrolledAt: '2026-08-26T00:00:00.000Z', notBefore: '2026-08-26T00:00:00.000Z',
      notAfter: '2027-08-26T00:00:00.000Z',
    };
    await stores.enrollmentStore.put(enrollment);
    await expect(stores.enrollmentStore.getByInstallation(enrollment.installationId)).resolves.toEqual(enrollment);
    await expect(stores.enrollmentStore.getBySerial(enrollment.certificateSerial)).resolves.toEqual(enrollment);
    const result = {
      schemaVersion: 'browser-execution-result.v1' as const,
      requestId: 'task19-request', status: 'PASS' as const,
      mutationAttempted: false, observations: { healthy: true }, evidence: [],
    };
    await stores.jobStore.put('task19-job', result);
    await expect(stores.jobStore.get('task19-job')).resolves.toEqual(result);
    await runtime.close();
    expect(runtime.liveness()).toEqual({ ok: false, state: 'closed' });
  });

  it('becomes unready on database loss, refuses guarded work, and never changes liveness', async () => {
    let databaseAvailable = true;
    const runtime = createAuthorityRuntime({
      environment: completeEnvironment(),
      probeOverride: async () => databaseAvailable,
    });
    await runtime.start();
    expect((await runtime.readiness()).ok).toBe(true);

    databaseAvailable = false;

    await expect(runtime.assertReady()).rejects.toMatchObject({ name: 'AuthorityUnavailableError' });
    expect((await runtime.readiness()).checks.database.ok).toBe(false);
    expect(runtime.liveness()).toEqual({ ok: true, state: 'running' });
    databaseAvailable = true;
    expect((await runtime.readiness()).ok).toBe(false);
    await runtime.recover();
    expect((await runtime.readiness()).ok).toBe(true);
    await runtime.close();
  });

  it('reports a stale schema precisely and constructs no stores or domain APIs', async () => {
    const createDomainApis = vi.fn();
    await owner.$executeRawUnsafe(
      `UPDATE "BlroRuntimeSchema" SET "version"='stale' WHERE "component"='control-tower-authority'`,
    );
    const runtime = createAuthorityRuntime({ environment: completeEnvironment(), createDomainApis });
    try {
      await runtime.start();
      await expect(runtime.readiness()).resolves.toMatchObject({
        ok: false,
        checks: { database: { ok: true }, schema: { ok: false }, scope: { ok: false } },
      });
      expect(runtime.resources()).toBeUndefined();
      expect(createDomainApis).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      await owner.$executeRawUnsafe(
        `UPDATE "BlroRuntimeSchema" SET "version"=$1 WHERE "component"='control-tower-authority'`,
        BLRO_RUNTIME_SCHEMA_VERSION,
      );
    }
  });

  it('marks itself unready before draining and closes resources once', async () => {
    const runtime = createAuthorityRuntime({ environment: completeEnvironment() });
    await runtime.start();

    const close = runtime.resources()?.close;
    runtime.beginDrain();

    expect((await runtime.readiness()).checks.drain.ok).toBe(false);
    await expect(runtime.assertReady()).rejects.toMatchObject({ name: 'AuthorityUnavailableError' });
    await runtime.close();
    await runtime.close();
    expect(close).toBeDefined();
    expect(runtime.liveness()).toEqual({ ok: false, state: 'closed' });
  });
});
