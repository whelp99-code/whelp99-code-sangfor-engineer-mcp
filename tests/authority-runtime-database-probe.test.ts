import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAuthorityRuntime,
  type AuthorityRuntimeEnvironment,
} from '../apps/control-tower/src/authority-runtime.js';
import { createTowerServer } from '../apps/control-tower/src/server.js';
import { createTaskCertificateFixture } from './helpers/blro-certificate-fixture.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://blro_app:blro_app_local@127.0.0.1:55432/blro';
const OWNER_URL = process.env.BLRO_OWNER_DATABASE_URL
  ?? 'postgresql://blro_owner:blro_owner_local@127.0.0.1:55432/blro';
const taskId = randomUUID();
const tenantId = `probe-tenant-${taskId}`;
const projectId = `probe-project-${taskId}`;
let owner: PrismaClient;
let root: string;
let environment: AuthorityRuntimeEnvironment;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'authority-probe-parallel-'));
  const signingPath = join(root, 'signing.key');
  const trustPath = join(root, 'ca.crt');
  writeFileSync(signingPath, generateKeyPairSync('ed25519').privateKey.export({
    format: 'pem', type: 'pkcs8',
  }), { mode: 0o600 });
  const fixture = createTaskCertificateFixture(
    join(root, 'certificates'), `probe-installation-${taskId}`, 'd'.repeat(64),
  );
  writeFileSync(trustPath, fixture.trustedCaPem);
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
    `INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2)`, tenantId, 'Parallel probe tenant',
  );
  await owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
    await transaction.$executeRawUnsafe(
      `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`,
      projectId, tenantId, 'Parallel probe project',
    );
  });
});

afterAll(async () => {
  await owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
    await transaction.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
  });
  await owner.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId);
  await owner.$disconnect();
  rmSync(root, { recursive: true, force: true });
});

describe('authority runtime database probe isolation', () => {
  it('keeps canonical HTTP readiness true while a unique stale component probe runs in parallel', async () => {
    const expectedSchemaComponent = `task-parallel-stale-authority-${randomUUID()}`;
    await owner.$executeRawUnsafe(
      `INSERT INTO "BlroRuntimeSchema" ("component","version") VALUES ($1,$2)`,
      expectedSchemaComponent, 'stale',
    );
    let probeCalls = 0;
    let releaseCanonicalProbe = () => {};
    const canonicalProbeReleased = new Promise<void>((resolve) => { releaseCanonicalProbe = resolve; });
    let markCanonicalProbeEntered = () => {};
    const canonicalProbeEntered = new Promise<void>((resolve) => { markCanonicalProbeEntered = resolve; });
    const canonical = createAuthorityRuntime({
      environment,
      probeOverride: async () => {
        probeCalls += 1;
        if (probeCalls > 1) {
          markCanonicalProbeEntered();
          await canonicalProbeReleased;
        }
        return true;
      },
    });
    const stale = createAuthorityRuntime({ environment, expectedSchemaComponent });
    const server = createTowerServer({ authorityMode: 'local', authorityRuntime: canonical, apiToken: 'parallel-readiness-token' });
    try {
      await canonical.start();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new TypeError('Expected HTTP address.');
      const readinessResponse = fetch(`http://127.0.0.1:${address.port}/ready`);
      await canonicalProbeEntered;
      await stale.start();
      await expect(stale.readiness()).resolves.toMatchObject({
        ok: false,
        checks: { database: { ok: true }, schema: { ok: false }, scope: { ok: false } },
      });
      expect(stale.resources()).toBeUndefined();
      releaseCanonicalProbe();
      const response = await readinessResponse;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true, checks: { database: { ok: true }, schema: { ok: true }, scope: { ok: true } },
      });
    } finally {
      releaseCanonicalProbe();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([canonical.close(), stale.close()]);
      await owner.$executeRawUnsafe(
        `DELETE FROM "BlroRuntimeSchema" WHERE "component"=$1`, expectedSchemaComponent,
      );
    }
  });
});
