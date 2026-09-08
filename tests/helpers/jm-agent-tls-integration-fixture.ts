import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  REMOTE_BROWSER_JOB_PATH,
  buildRemoteJobEnvelope,
  formatContractVersion,
} from '../../packages/sangfor-browser-contracts/src/index.js';
import {
  RECEIPT_HEADER,
  RECEIPT_ID_HEADER,
} from '../../packages/sangfor-jm-agent/src/index.js';
import { composeJmAgent, JmAgentStartupError } from '../../apps/jm-browser-agent/src/composition.js';
import { createJmAgentServer, type JmAgentServer } from '../../apps/jm-browser-agent/src/server.js';
import {
  JmStartupPreflightError, buildCoordinator, exitCodeFor, installSignalHandlers,
  startJmAgentProcess,
} from '../../apps/jm-browser-agent/src/process.js';
import {
  operatedReadinessPreflight, operatedStartupPreflight, probeLoopbackBind,
} from '../../apps/jm-browser-agent/src/operated-execution.js';
import { checkServerIdentity } from '../../packages/sangfor-jm-agent/src/index.js';
import {
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
  JM_JOURNAL_GENESIS,
  JM_ORIGIN,
  JM_PROJECT_ID,
  JM_SESSION_ID,
  JM_TENANT_ID,
  browserRequest,
  buildAuthorityReceipt,
  buildGrantSnapshot,
  createFakeExecutionPort,
  createJmSigningMaterial,
  createJmTlsMaterial,
  initialiseTestJournal,
  mintTaskCapability,
  type FakeExecutionPort,
  type JmSigningMaterial,
  type JmTlsMaterial,
} from './jm-agent-fixture.js';
import { ExactSignal } from './exact-signal.js';

let root: string;
let tls: JmTlsMaterial;
let signing: JmSigningMaterial;
let snapshotPath: string;
let profileRoot: string;
let chromiumStub: string;

/** An operator-initialised journal root; production never creates one. */
export function freshJournalRoot(): string {
  const root = join(mkdtempSync(join(tmpdir(), 'jm-journal-')), 'jm');
  initialiseTestJournal(root, { journalEpoch: 7, genesisDigest: JM_JOURNAL_GENESIS });
  return root;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jm-agent-tls-'));
  tls = createJmTlsMaterial(root);
  signing = createJmSigningMaterial(root);
  profileRoot = join(root, 'profile');
  mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  chmodSync(profileRoot, 0o700);
  // A REAL regular executable; the preflight rejects symlinked browser paths.
  chromiumStub = join(root, 'chromium-stub');
  writeFileSync(chromiumStub, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  snapshotPath = join(root, 'snapshot.jws');
  writeFileSync(snapshotPath, buildGrantSnapshot(signing));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

export function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SANGFOR_JM_AGENT_BIND_HOST: '127.0.0.1',
    // Ephemeral port: concurrent checkouts of this suite cannot collide.
    SANGFOR_JM_AGENT_PORT: '0',
    SANGFOR_JM_AGENT_TLS_CERT_PATH: tls.serverCertPath,
    SANGFOR_JM_AGENT_TLS_KEY_PATH: tls.serverKeyPath,
    SANGFOR_JM_AGENT_TLS_CLIENT_CA_PATH: tls.caPath,
    SANGFOR_JM_AGENT_BLRO_CLIENT_FINGERPRINT_SHA256: tls.clientFingerprint256,
    SANGFOR_JM_AGENT_BLRO_CLIENT_SUBJECT_CN: 'blro-control-tower',
    SANGFOR_JM_AGENT_BLRO_CLIENT_SERIAL: tls.clientSerial,
    SANGFOR_JM_AGENT_BLRO_CLIENT_SAN_URI: tls.clientSubjectAltName,
    SANGFOR_JM_AGENT_BLRO_CLIENT_ISSUER_CN: 'Task26-Trusted-CA',
    SANGFOR_JM_AGENT_VERIFY_KEY_RING_PATH: signing.keyRingPath,
    SANGFOR_JM_AGENT_GRANT_SNAPSHOT_PATH: snapshotPath,
    SANGFOR_JM_AGENT_JOURNAL_ROOT: freshJournalRoot(),
    SANGFOR_JM_AGENT_TENANT_ID: JM_TENANT_ID,
    SANGFOR_JM_AGENT_PROJECT_ID: JM_PROJECT_ID,
    SANGFOR_JM_AGENT_INSTALLATION_ID: JM_INSTALLATION_ID,
    SANGFOR_JM_AGENT_DEVICE_BINDING_DIGEST: JM_DEVICE_DIGEST,
    SANGFOR_JM_AGENT_BROWSER_PROFILE_REF: 'task26-profile',
    SANGFOR_JM_AGENT_BROWSER_PROFILE_ROOT: profileRoot,
    SANGFOR_JM_AGENT_BROWSER_SESSION_ID: JM_SESSION_ID,
    SANGFOR_JM_AGENT_BROWSER_CHROMIUM_PATH: '/usr/bin/chromium',
    SANGFOR_JM_AGENT_ALLOWED_ORIGIN: JM_ORIGIN,
    SANGFOR_JM_AGENT_JOB_TIMEOUT_MS: '30000',
    SANGFOR_JM_AGENT_DRAIN_DEADLINE_MS: '5000',
    SANGFOR_JM_AGENT_SNAPSHOT_MAX_AGE_MS: '900000',
    ...overrides,
  };
}

export type Response = { readonly status: number; readonly body: string };

export type CallOptions = {
  readonly clientCert?: boolean;
  readonly foreign?: boolean;
  readonly body?: string;
  readonly receipt?: string;
  readonly receiptId?: string;
  readonly jobId?: string;
};

export function call(port: number, path: string, options: CallOptions = {}): Promise<Response> {
  const identity: RequestOptions = options.foreign
    ? { cert: readFileSync(tls.foreignClientCertPath), key: readFileSync(tls.foreignClientKeyPath) }
    : options.clientCert === false
      ? {}
      : { cert: readFileSync(tls.clientCertPath), key: readFileSync(tls.clientKeyPath) };
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest({
      host: '127.0.0.1',
      port,
      path,
      method: options.body === undefined ? 'GET' : 'POST',
      ca: readFileSync(tls.caPath),
      servername: 'localhost',
      headers: {
        [CONTRACT_VERSION_HEADER]: formatContractVersion(BLRO_CONTRACT_VERSION),
        ...(options.receipt === undefined ? {} : { [RECEIPT_HEADER]: options.receipt }),
        ...(options.receiptId === undefined ? {} : { [RECEIPT_ID_HEADER]: options.receiptId }),
        ...(options.jobId === undefined ? {} : { 'x-sangfor-job-id': options.jobId }),
      },
      ...identity,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.once('error', reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

/** A complete, correctly bound dispatch: envelope body plus its receipt. */
export function signedDispatch(overrides: {
  readonly jti?: string;
  readonly fingerprint?: string;
  readonly receiptPatch?: Parameters<typeof buildAuthorityReceipt>[2];
} = {}) {
  const request = browserRequest();
  const jti = overrides.jti ?? `jti-${request.requestId}`;
  const capability = mintTaskCapability(signing, request, { jti, jobId: request.requestId });
  const envelope = buildRemoteJobEnvelope(request, {
    tenantId: JM_TENANT_ID,
    projectId: JM_PROJECT_ID,
    capability,
  });
  const receipt = buildAuthorityReceipt(signing, {
    request,
    jobId: envelope.jobId,
    capability,
    capabilityJti: jti,
    clientFingerprint: overrides.fingerprint ?? tls.clientFingerprint256,
  }, overrides.receiptPatch ?? {});
  const payload = receipt.split('.')[0] ?? '';
  const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const receiptId = (decoded as { readonly receiptId: string }).receiptId;
  return { body: JSON.stringify(envelope), receipt, receiptId, jobId: envelope.jobId, request };
}

export type Harness = {
  readonly port: number;
  readonly server: JmAgentServer;
  readonly composition: ReturnType<typeof composeJmAgent>;
  readonly fake: FakeExecutionPort;
};

export async function withServer(
  overrides: Record<string, string>,
  body: (harness: Harness) => Promise<void>,
  fake: FakeExecutionPort = createFakeExecutionPort(),
): Promise<void> {
  const composition = composeJmAgent(environment(overrides), { executionPort: fake });
  const server = createJmAgentServer(composition);
  const port = await server.listen();
  try {
    await body({ port, server, composition, fake });
  } finally {
    await server.close();
  }
}

export const tlsMaterial = (): JmTlsMaterial => tls;
export const signingMaterial = (): JmSigningMaterial => signing;
export const fixtureRoot = (): string => root;
export const profileRootPath = (): string => profileRoot;
export const chromiumStubPath = (): string => chromiumStub;
