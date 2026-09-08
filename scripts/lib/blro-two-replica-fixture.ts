import { createHash, createPublicKey, X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRemoteJobEnvelope,
  type BrowserExecutionRequest,
  type BrowserExecutionResult,
} from '../../packages/sangfor-browser-contracts/src/index.js';
import { startJmAgentProcess, type JmAgentProcess } from '../../apps/jm-browser-agent/src/process.js';
import {
  CURRENT_KEY_ID,
  JM_CLIENT_IDENTITY_ID,
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
  JM_JOURNAL_GENESIS,
  JM_ORIGIN,
  JM_PROJECT_ID,
  JM_SESSION_ID,
  JM_TENANT_ID,
  buildGrantSnapshot,
  createFakeExecutionPort,
  createJmSigningMaterial,
  createJmTlsMaterial,
  initialiseTestJournal,
  mintTaskCapability,
} from '../../tests/helpers/jm-agent-fixture.js';
import { createTaskCertificateFixture } from '../../tests/helpers/blro-certificate-fixture.js';
import { createHarnessAuthorityDatabase } from './blro-two-replica-database.js';
import type { ReplicaConfig } from './blro-two-replica-types.js';

export type TwoReplicaFixture = {
  readonly configs: readonly [ReplicaConfig, ReplicaConfig];
  readonly body: (input: { readonly requestId: string; readonly jobId: string;
    readonly jti: string; readonly digestVariant?: string;
    readonly purpose?: 'mutation' | 'verification' }) => string;
  readonly jmCalls: () => number;
  readonly verificationCollectionCalls: () => number;
  readonly armJm: () => { readonly started: Promise<void>; readonly release: () => void };
  readonly queryCounts: () => Promise<{ readonly jobs: number; readonly jtis: number }>;
  readonly winnerJti: (jobId: string) => Promise<string>;
  readonly revoke: () => Promise<void>;
  readonly stopJm: () => Promise<void>;
  readonly startJm: () => Promise<void>;
  readonly close: () => Promise<void>;
};

export async function createTwoReplicaFixture(input: {
  readonly databaseUrl: string;
  readonly ownerUrl: string;
  readonly jmUrl: string;
  readonly collectVerification?: (request: BrowserExecutionRequest) => Promise<BrowserExecutionResult>;
}): Promise<TwoReplicaFixture> {
  const root = mkdtempSync(join(tmpdir(), 'blro-two-replica-'));
  const tls = createJmTlsMaterial(root);
  const authorityCertificate = createTaskCertificateFixture(
    join(root, 'authority-certificate'), JM_INSTALLATION_ID, JM_DEVICE_DIGEST,
  );
  const signing = createJmSigningMaterial(root);
  const snapshotPath = join(root, 'snapshot.jws');
  writeFileSync(snapshotPath, buildGrantSnapshot(signing, { authorityEpoch: 7 }));
  const journalRoot = join(root, 'journal');
  initialiseTestJournal(journalRoot, { journalEpoch: 7, genesisDigest: JM_JOURNAL_GENESIS });
  const profileRoot = join(root, 'profile');
  mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  chmodSync(profileRoot, 0o700);
  const chromium = join(root, 'chromium');
  writeFileSync(chromium, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  let executionBarrier: { readonly started: () => void; readonly released: Promise<void> } | undefined;
  const fakeExecution = createFakeExecutionPort({ hold: async () => {
    const barrier = executionBarrier;
    if (!barrier) return;
    barrier.started();
    await barrier.released;
    executionBarrier = undefined;
  } });
  let verificationCollectionCalls = 0;
  const collectVerification = input.collectVerification;
  const execution = collectVerification === undefined
    ? fakeExecution
    : {
        ...fakeExecution,
        async execute(request: BrowserExecutionRequest, context: Parameters<typeof fakeExecution.execute>[1]) {
          const observed = await fakeExecution.execute(request, context);
          if (observed.error?.code === 'JM_EXECUTION_ABORTED') return observed;
          switch (request.operation.kind) {
            case 'verify_console':
              verificationCollectionCalls += 1;
              return collectVerification(request);
            case 'observe_console':
            case 'perform_console_action':
            case 'capture_console_evidence':
            case 'capture_structure':
            case 'extract_authenticated_knowledge':
            case 'close_session':
              return observed;
            default:
              return assertNever(request.operation);
          }
        },
      };
  const environment = jmEnvironment({ tls, signing, snapshotPath,
    journalRoot, profileRoot, chromium });
  const trustedIssuerBundle = `${readFileSync(tls.caPath, 'utf8')}\n${authorityCertificate.trustedCaPem}`;
  const authority = await createHarnessAuthorityDatabase({
    databaseUrl: input.databaseUrl, ownerUrl: input.ownerUrl,
    certificateDerBase64: authorityCertificate.validDerBase64, trustedIssuerBundle,
  });
  let jm: JmAgentProcess | undefined;
  try {
    jm = await startJmAgentProcess(environment, { executionPort: execution });
  } catch (error) {
    await authority.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const clientCertificatePem = readFileSync(tls.clientCertPath, 'utf8');
  const client = new X509Certificate(clientCertificatePem);
  const server = new X509Certificate(readFileSync(tls.serverCertPath, 'utf8'));
  const publicKey = createPublicKey(signing.currentPrivateKey);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const base = {
    databaseUrl: input.databaseUrl,
    tenantId: JM_TENANT_ID,
    projectId: JM_PROJECT_ID,
    installationId: JM_INSTALLATION_ID,
    clientIdentityId: JM_CLIENT_IDENTITY_ID,
    deviceBindingDigest: JM_DEVICE_DIGEST,
    origin: JM_ORIGIN,
    endpointUrl: new URL('/v1/browser-jobs', input.jmUrl).origin,
    capabilityPublicKey: publicPem,
    signingPrivateKey: signing.currentPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    trustedIssuerBundle,
    clientCertificate: authorityCertificate.validDerBase64,
    clientCertificatePem,
    clientKeyPem: readFileSync(tls.clientKeyPath, 'utf8'),
    caPem: readFileSync(tls.caPath, 'utf8'),
    serverFingerprint: server.fingerprint256.replaceAll(':', '').toLowerCase(),
    keyId: CURRENT_KEY_ID,
    keyDigest: createHash('sha256').update(publicPem.trim(), 'utf8').digest('hex'),
    clientFingerprint: client.fingerprint256.replaceAll(':', '').toLowerCase(),
  };
  const configs = [
    { ...base, identity: 'blro-replica-1', port: 39441 },
    { ...base, identity: 'blro-replica-2', port: 39442 },
  ] satisfies readonly [ReplicaConfig, ReplicaConfig];
  return {
    configs,
    body: ({ requestId, jobId, jti, digestVariant, purpose }) => jobBody(signing, { requestId, jobId, jti, digestVariant, purpose }),
    jmCalls: execution.calls,
    verificationCollectionCalls: () => verificationCollectionCalls,
    armJm: () => {
      let started: () => void = () => undefined;
      let release: () => void = () => undefined;
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      executionBarrier = { started, released };
      return { started: startedPromise, release };
    },
    queryCounts: authority.queryCounts,
    winnerJti: authority.winnerJti,
    revoke: authority.revoke,
    stopJm: async () => { await jm?.drain(); jm = undefined; },
    startJm: async () => { jm = await startJmAgentProcess(environment, { executionPort: execution }); },
    close: async () => {
      await jm?.drain();
      await authority.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function jobBody(signing: ReturnType<typeof createJmSigningMaterial>, input: {
  readonly requestId: string; readonly jobId: string; readonly jti: string; readonly digestVariant?: string;
  readonly purpose?: 'mutation' | 'verification';
}): string {
  const request: BrowserExecutionRequest = {
    schemaVersion: 'browser-execution-request.v1', requestId: input.requestId,
    sessionId: JM_SESSION_ID, origin: JM_ORIGIN,
    operation: input.purpose === 'verification'
      ? { kind: 'verify_console', checks: [{ id: 'system', kind: 'field_equals', expected: 'enabled' }] }
      : { kind: 'perform_console_action', action: {
          type: 'click', target: input.digestVariant ?? 'Apply', dryRun: false,
        } },
  };
  const capability = mintTaskCapability(signing, request, { jti: input.jti, jobId: input.jobId,
    authorityEpoch: 7 });
  return JSON.stringify(buildRemoteJobEnvelope(request, {
    tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID,
    runId: request.sessionId, stepId: request.requestId,
    jobId: () => input.jobId, capability,
  }));
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled browser operation: ${JSON.stringify(value)}`);
}

function jmEnvironment(input: { readonly tls: ReturnType<typeof createJmTlsMaterial>;
  readonly signing: ReturnType<typeof createJmSigningMaterial>; readonly snapshotPath: string;
  readonly journalRoot: string; readonly profileRoot: string; readonly chromium: string }): Record<string, string> {
  return {
    SANGFOR_JM_AGENT_BIND_HOST: '127.0.0.1', SANGFOR_JM_AGENT_PORT: '39443',
    SANGFOR_JM_AGENT_TLS_CERT_PATH: input.tls.serverCertPath,
    SANGFOR_JM_AGENT_TLS_KEY_PATH: input.tls.serverKeyPath,
    SANGFOR_JM_AGENT_TLS_CLIENT_CA_PATH: input.tls.caPath,
    SANGFOR_JM_AGENT_BLRO_CLIENT_FINGERPRINT_SHA256: input.tls.clientFingerprint256,
    SANGFOR_JM_AGENT_BLRO_CLIENT_SUBJECT_CN: 'blro-control-tower',
    SANGFOR_JM_AGENT_BLRO_CLIENT_SERIAL: input.tls.clientSerial,
    SANGFOR_JM_AGENT_BLRO_CLIENT_SAN_URI: input.tls.clientSubjectAltName,
    SANGFOR_JM_AGENT_BLRO_CLIENT_ISSUER_CN: 'Task26-Trusted-CA',
    SANGFOR_JM_AGENT_VERIFY_KEY_RING_PATH: input.signing.keyRingPath,
    SANGFOR_JM_AGENT_GRANT_SNAPSHOT_PATH: input.snapshotPath,
    SANGFOR_JM_AGENT_JOURNAL_ROOT: input.journalRoot,
    SANGFOR_JM_AGENT_TENANT_ID: JM_TENANT_ID, SANGFOR_JM_AGENT_PROJECT_ID: JM_PROJECT_ID,
    SANGFOR_JM_AGENT_INSTALLATION_ID: JM_INSTALLATION_ID,
    SANGFOR_JM_AGENT_DEVICE_BINDING_DIGEST: JM_DEVICE_DIGEST,
    SANGFOR_JM_AGENT_BROWSER_PROFILE_REF: 'todo28-profile',
    SANGFOR_JM_AGENT_BROWSER_PROFILE_ROOT: input.profileRoot,
    SANGFOR_JM_AGENT_BROWSER_SESSION_ID: JM_SESSION_ID,
    SANGFOR_JM_AGENT_BROWSER_CHROMIUM_PATH: input.chromium,
    SANGFOR_JM_AGENT_ALLOWED_ORIGIN: JM_ORIGIN,
    SANGFOR_JM_AGENT_JOB_TIMEOUT_MS: '30000', SANGFOR_JM_AGENT_DRAIN_DEADLINE_MS: '5000',
    SANGFOR_JM_AGENT_SNAPSHOT_MAX_AGE_MS: '900000',
  };
}
