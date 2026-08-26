import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createAuthorityRuntime,
  type AuthorityRuntimeEnvironment,
} from '../apps/control-tower/src/authority-runtime.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://blro_app:blro_app_local@127.0.0.1:55432/blro';
const OWNER_URL = 'postgresql://blro_owner:blro_owner_local@127.0.0.1:55432/blro';
const suffix = randomUUID();
const tenantId = `domain-tenant-${suffix}`;
const projectId = `domain-project-${suffix}`;
let root: string;
let owner: PrismaClient;
let environment: AuthorityRuntimeEnvironment;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'authority-domain-'));
  const signingPath = join(root, 'signing.key');
  const trustPath = join(root, 'ca.crt');
  writeFileSync(signingPath, generateKeyPairSync('ed25519').privateKey.export({
    format: 'pem', type: 'pkcs8',
  }), { mode: 0o600 });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=domain-api-ca', '-keyout', join(root, 'ca.key'), '-out', trustPath,
  ], { stdio: 'pipe' });
  environment = {
    SANGFOR_BLRO_AUTHORITY_STORE: 'postgres', DATABASE_URL,
    SANGFOR_TENANT_ID: tenantId, SANGFOR_PROJECT_ID: projectId,
    SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH: signingPath,
    SANGFOR_BLRO_TRUST_BUNDLE_PATH: trustPath,
    SANGFOR_BLRO_AUDIT_SECRET: 'a'.repeat(32),
    SANGFOR_OPERATOR_APPROVAL_SECRET: 'o'.repeat(32),
  };
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.$executeRawUnsafe(
    `INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2)`, tenantId, 'Domain API tenant',
  );
  await owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
    await transaction.$executeRawUnsafe(
      `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`,
      projectId, tenantId, 'Domain API project',
    );
  });
});

afterAll(async () => {
  await owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
    await transaction.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
  });
  await owner.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId);
  await owner.$disconnect();
  rmSync(root, { recursive: true, force: true });
});

describe('BLRO required domain API composition', () => {
  it.each([
    ['empty', () => ({})],
    ['partial', (dependencies: Record<string, unknown>) => ({ authority: dependencies.authorityStore })],
  ])('stays unready when an injected factory returns %s capabilities', async (_name, createDomainApis) => {
    const runtime = createAuthorityRuntime({ environment, createDomainApis });

    await runtime.start();

    await expect(runtime.readiness()).resolves.toMatchObject({
      ok: false,
      checks: { database: { ok: true }, scope: { ok: true }, domainApis: { ok: false } },
    });
    expect(runtime.resources()).toBeUndefined();
    await expect(runtime.assertReady()).rejects.toMatchObject({ reason: 'DOMAIN_APIS_INVALID' });
    await runtime.close();
  });

  it('stays unready and closes Prisma when the injected factory throws', async () => {
    const runtime = createAuthorityRuntime({
      environment,
      createDomainApis: () => { throw new TypeError('factory fixture failed'); },
    });

    await runtime.start();

    await expect(runtime.readiness()).resolves.toMatchObject({
      ok: false,
      checks: { database: { ok: true }, schema: { ok: true }, scope: { ok: true }, domainApis: { ok: false } },
    });
    expect(runtime.resources()).toBeUndefined();
    await runtime.close();
  });

  it('constructs the complete default capability set from the exact shared resources and closes once', async () => {
    const runtime = createAuthorityRuntime({ environment });
    await runtime.start();
    const resources = runtime.resources();
    if (!resources) throw new Error('authority resources missing');
    const disconnect = vi.spyOn(resources.prisma, '$disconnect');

    expect(Object.keys(resources.domainApis).sort()).toEqual([
      'approvalNonces', 'authority', 'enrollments', 'jobs',
    ]);
    expect(resources.domainApis.authority).toBe(resources.authorityStore);
    expect(resources.domainApis.approvalNonces).toBe(resources.nonceStore);
    expect(resources.domainApis.enrollments).toBe(resources.enrollmentStore);
    expect(resources.domainApis.jobs).toBe(resources.jobStore);
    await expect(runtime.readiness()).resolves.toMatchObject({
      ok: true,
      checks: { domainApis: { ok: true } },
    });
    await runtime.close();
    await runtime.close();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
