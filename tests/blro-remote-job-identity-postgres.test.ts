import { X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresEnrollmentRegistry } from '../packages/sangfor-authority/src/index.js';
import { RemoteJobAuthorityFixture } from './helpers/remote-job-authority-fixture.js';
import { ProbedRemoteJobDatabase } from './helpers/remote-job-database-probe.js';
import { taskPassResult } from './helpers/remote-job-result-fixture.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const ownerUrl = process.env.BLRO_OWNER_DATABASE_URL ?? '';
const runPostgres = Boolean(databaseUrl && ownerUrl);
let fixture: RemoteJobAuthorityFixture;

describe.runIf(runPostgres)('Todo 22 PostgreSQL remote-job identity authority', () => {
  beforeAll(async () => {
    fixture = await RemoteJobAuthorityFixture.create(databaseUrl, ownerUrl);
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it('refuses a superseded old certificate before retained-job lookup or dispatch', async () => {
    // Given an active enrollment whose old certificate is rotated and acknowledged as superseded.
    const registry = new PostgresEnrollmentRegistry({
      database: fixture.databaseA,
      scope: fixture.scope('primary'),
      clock: { now: () => fixture.now },
      trustedIssuerBundle: fixture.certificates.trustedCaPem,
    });
    const binding = {
      ...fixture.scope('primary'), installationId: fixture.installationId,
      deviceBindingDigest: fixture.deviceBindingDigest,
    };
    const rotated = await registry.rotate({
      ...binding, expectedRevision: 1,
      certificate: { encoding: 'pem', value: fixture.certificates.middlePem },
      overlapExpiresAt: new Date(fixture.now.getTime() + 600_000).toISOString(),
    });
    expect(rotated).toMatchObject({ ok: true, enrollment: { revision: 2 } });
    const acknowledged = await registry.acknowledgeRotation({
      ...binding, expectedRevision: 2,
      oldSerial: new X509Certificate(fixture.certificates.validPem).serialNumber,
      newSerial: new X509Certificate(fixture.certificates.middlePem).serialNumber,
    });
    expect(acknowledged).toMatchObject({ ok: true, enrollment: { revision: 3 } });
    const probe = new ProbedRemoteJobDatabase(fixture.databaseA);
    const execute = vi.fn(async () => taskPassResult('superseded-request'));
    const handler = fixture.handler(fixture.store(probe), { execute });

    // When the old certificate presents a fresh genuine capability.
    const response = await handler.handle(fixture.handlerInput(
      fixture.envelope({ request: fixture.request('superseded-request'), jobId: 'superseded-job' }),
      new X509Certificate(fixture.certificates.validPem).raw.toString('base64'),
    ));

    // Then authorization refuses before any remote-job row lookup or external dispatch.
    expect(response.statusCode).toBe(403);
    expect(probe.remoteJobLookups).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses one consumed JTI rebound across installation and project/job/digest boundaries', async () => {
    // Given a consumed JTI with one retained primary-project result.
    const primaryProbe = new ProbedRemoteJobDatabase(fixture.databaseA);
    const request = fixture.request('jti-original-request');
    const execute = vi.fn(async () => taskPassResult(request.requestId, 'jti-authority'));
    const primary = fixture.handler(fixture.store(primaryProbe), { execute });
    await primary.handle(fixture.handlerInput(fixture.envelope({
      request, jobId: 'jti-original-job', jti: 'globally-consumed-jti',
    })));
    const primaryLookups = primaryProbe.remoteJobLookups;

    // When that JTI is rebound first to another installation, then to another project/job/digest.
    const installationRebind = await primary.handle(fixture.handlerInput(fixture.envelope({
      request: fixture.request('jti-installation-rebind'), jobId: 'jti-installation-job',
      jti: 'globally-consumed-jti', installationId: 'different-installation',
      clientIdentityId: 'client:different-installation',
    })));
    const foreignProbe = new ProbedRemoteJobDatabase(fixture.databaseB);
    const foreign = fixture.handler(fixture.store(foreignProbe, 'foreign'), { execute });
    const projectRebind = await foreign.handle(fixture.handlerInput(fixture.envelope({
      scope: 'foreign', request: fixture.request('jti-project-rebind'),
      jobId: 'jti-foreign-job', jti: 'globally-consumed-jti',
    })));

    // Then neither rebound observes retained result state or calls the executor.
    expect(installationRebind.statusCode).toBe(403);
    expect(projectRebind.statusCode).toBe(403);
    expect(primaryProbe.remoteJobLookups).toBe(primaryLookups);
    expect(foreignProbe.remoteJobLookups).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
  });
});
