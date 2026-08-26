import {
  X509Certificate,
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  PostgresEnrollmentRegistry,
  PostgresRemoteJobStore,
  type RemoteJobDatabase,
} from '../../packages/sangfor-authority/src/index.js';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  REMOTE_BROWSER_JOB_PATH,
  buildRemoteJobEnvelope,
  createRemoteBrowserJobHandler,
  mintJobCapability,
  type BrowserExecutionPort,
  type BrowserExecutionRequest,
  type JobEnvelope,
  type RemoteHandlerInput,
} from '../../packages/sangfor-browser-contracts/src/index.js';
import { digestCanonicalOrigin } from '../../packages/shared/src/index.js';
import {
  createTaskCertificateFixture,
  type TaskCertificateFixture,
} from './blro-certificate-fixture.js';
import {
  clearTaskAuthority,
  deleteTaskAuthority,
  seedTaskAuthority,
} from './remote-job-scope-fixture.js';

export type TaskScopeName = 'primary' | 'foreign';
export type EnvelopeInput = {
  readonly scope?: TaskScopeName;
  readonly jobId?: string;
  readonly jti?: string;
  readonly request?: BrowserExecutionRequest;
  readonly installationId?: string;
  readonly clientIdentityId?: string;
  readonly privateKey?: string;
  readonly issuedAt?: Date;
  readonly expiresAt?: Date;
};

export class RemoteJobAuthorityFixture {
  readonly now = new Date('2026-08-26T13:00:00.000Z');
  readonly origin = 'https://console.task22.test';
  readonly tenantId = `task22-tenant-${randomUUID()}`;
  readonly installationId = `task22-installation-${randomUUID()}`;
  readonly deviceBindingDigest = createHash('sha256').update(this.installationId).digest('hex');
  readonly clientIdentityId = `client:${this.installationId}`;
  readonly primaryProjectId = `task22-project-a-${randomUUID()}`;
  readonly foreignProjectId = `task22-project-b-${randomUUID()}`;
  readonly owner: PrismaClient;
  readonly databaseA: PrismaClient;
  readonly databaseB: PrismaClient;
  readonly certificates: TaskCertificateFixture;
  readonly privateKey: string;
  readonly publicKey: string;
  private readonly root: string;

  private constructor(databaseUrl: string, ownerUrl: string) {
    this.root = mkdtempSync(join(tmpdir(), 'task22-remote-job-'));
    this.certificates = createTaskCertificateFixture(
      join(this.root, 'certificates'),
      this.installationId,
      this.deviceBindingDigest,
    );
    const keys = generateKeyPairSync('ed25519');
    this.privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    this.publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    this.owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    this.databaseA = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    this.databaseB = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  }

  static async create(databaseUrl: string, ownerUrl: string): Promise<RemoteJobAuthorityFixture> {
    const fixture = new RemoteJobAuthorityFixture(databaseUrl, ownerUrl);
    await seedTaskAuthority(fixture.databaseFixtureInput());
    await fixture.reset();
    return fixture;
  }

  scope(name: TaskScopeName) {
    return { tenantId: this.tenantId,
      projectId: name === 'primary' ? this.primaryProjectId : this.foreignProjectId };
  }

  request(requestId = `request-${randomUUID()}`): BrowserExecutionRequest {
    return {
      schemaVersion: 'browser-execution-request.v1',
      requestId,
      sessionId: `session-${this.installationId}`,
      origin: this.origin,
      operation: { kind: 'observe_console' },
    };
  }

  envelope(input: EnvelopeInput = {}): JobEnvelope {
    const scope = this.scope(input.scope ?? 'primary');
    const request = input.request ?? this.request();
    const issuedAt = input.issuedAt ?? this.now;
    const expiresAt = input.expiresAt ?? new Date(issuedAt.getTime() + 60_000);
    const jobId = input.jobId ?? request.requestId;
    return buildRemoteJobEnvelope(request, {
      ...scope,
      runId: `run-${jobId}`,
      stepId: `step-${jobId}`,
      jobId: () => jobId,
      now: () => issuedAt,
      ttlMs: expiresAt.getTime() - issuedAt.getTime(),
      capability: ({ runId, stepId }) => mintJobCapability({
        ...scope,
        runId,
        stepId,
        jobId,
        clientIdentityId: input.clientIdentityId ?? this.clientIdentityId,
        installationId: input.installationId ?? this.installationId,
        request,
        issuedAt,
        expiresAt,
        jti: input.jti ?? randomUUID(),
        privateKey: input.privateKey ?? this.privateKey,
      }),
    });
  }

  handlerInput(envelope: JobEnvelope, certificate = this.certificates.validDerBase64): RemoteHandlerInput {
    return {
      client: {
        fingerprint256: new X509Certificate(Buffer.from(certificate, 'base64')).fingerprint256,
        tlsAuthorized: true,
        certificate: { encoding: 'der-base64', value: certificate },
        raw: {},
      },
      method: 'POST',
      urlPath: REMOTE_BROWSER_JOB_PATH,
      bodyText: JSON.stringify(envelope),
      headers: {
        [CONTRACT_VERSION_HEADER]: `${BLRO_CONTRACT_VERSION.major}.${BLRO_CONTRACT_VERSION.minor}`,
      },
    };
  }

  store(database: RemoteJobDatabase = this.databaseA, scope: TaskScopeName = 'primary') {
    return new PostgresRemoteJobStore({
      database,
      scope: this.scope(scope),
      capabilityPublicKey: this.publicKey,
      trustedIssuerBundle: this.certificates.trustedCaPem,
      clock: { now: () => this.now },
    });
  }

  handler(store: PostgresRemoteJobStore, executor: BrowserExecutionPort) {
    return createRemoteBrowserJobHandler({ jobStore: store, executor,
      authorizeClient: () => true, now: () => this.now });
  }

  async reset(): Promise<void> {
    await clearTaskAuthority(this.databaseFixtureInput());
    for (const scopeName of ['primary', 'foreign'] as const) {
      const scope = this.scope(scopeName);
      const registry = new PostgresEnrollmentRegistry({
        database: this.databaseA,
        scope,
        clock: { now: () => this.now },
        trustedIssuerBundle: this.certificates.trustedCaPem,
      });
      const bootstrapToken = randomBytes(32).toString('base64url');
      await registry.issueBootstrapToken({
        ...scope,
        installationId: this.installationId,
        deviceBindingDigest: this.deviceBindingDigest,
        tokenDigest: createHash('sha256').update(bootstrapToken).digest('hex'),
        expiresAt: new Date(this.now.getTime() + 60_000).toISOString(),
        grants: [{
          originDigest: digestCanonicalOrigin(this.origin, 'origin'),
          scope: 'browser:execute',
        }],
      });
      await registry.claimBootstrapToken({
        ...scope,
        installationId: this.installationId,
        deviceBindingDigest: this.deviceBindingDigest,
        bootstrapToken,
        clientIdentityId: this.clientIdentityId,
        certificate: { encoding: 'der-base64', value: this.certificates.validDerBase64 },
      });
    }
  }

  async revokePrimary(): Promise<void> {
    const registry = new PostgresEnrollmentRegistry({
      database: this.databaseA,
      scope: this.scope('primary'),
      clock: { now: () => this.now },
      trustedIssuerBundle: this.certificates.trustedCaPem,
    });
    await registry.revoke({
      ...this.scope('primary'),
      installationId: this.installationId,
      deviceBindingDigest: this.deviceBindingDigest,
      expectedRevision: 1,
      reason: 'Todo 22 revocation probe',
    });
  }

  async close(): Promise<void> {
    await deleteTaskAuthority(this.databaseFixtureInput());
    await Promise.all([
      this.owner.$disconnect(),
      this.databaseA.$disconnect(),
      this.databaseB.$disconnect(),
    ]);
    rmSync(this.root, { recursive: true, force: true });
  }

  private databaseFixtureInput() {
    return { owner: this.owner, lineage: { tenantId: this.tenantId,
      projectIds: [this.primaryProjectId, this.foreignProjectId] as const } };
  }
}
