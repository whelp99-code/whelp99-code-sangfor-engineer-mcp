import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createHash, randomUUID, type KeyObject } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  browserExecutionRequestDigest,
  deriveReservationDigest,
  mintJobCapability,
  type BrowserExecutionRequest,
  type BrowserExecutionResult,
} from '../../packages/sangfor-browser-contracts/src/index.js';
import { signJmAuthorityArtifact } from '../../packages/sangfor-authority/src/index.js';
import {
  JOURNAL_FILE_NAME,
  JOURNAL_HEADER_KIND,
  KEY_RING_VERSION,
  appendDurably,
  createJournalExclusively,
  journalHeaderLine,
  publicKeyDigest,
  type AuthorityReceipt,
  type ExecutionPreflight,
  type GrantSnapshot,
  type JmExecutionPort,
} from '../../packages/sangfor-jm-agent/src/index.js';

export const JM_TENANT_ID = 'task26-tenant';
export const JM_PROJECT_ID = 'task26-project';
export const JM_INSTALLATION_ID = 'task26-installation';
export const JM_CLIENT_IDENTITY_ID = 'client:task26-installation';
export const JM_ORIGIN = 'https://console.task26.invalid';
export const JM_DEVICE_DIGEST = createHash('sha256').update('task26-device').digest('hex');
export const JM_SESSION_ID = 'task26-session';
export const CURRENT_KEY_ID = 'blro-key-current';
export const OVERLAP_KEY_ID = 'blro-key-overlap';

function openssl(args: readonly string[]): void {
  execFileSync('openssl', [...args], { stdio: 'pipe' });
}

export type JmTlsMaterial = {
  readonly caPath: string;
  readonly serverCertPath: string;
  readonly serverKeyPath: string;
  readonly clientCertPath: string;
  readonly clientKeyPath: string;
  readonly foreignClientCertPath: string;
  readonly foreignClientKeyPath: string;
  readonly otherServerCertPath: string;
  readonly otherServerKeyPath: string;
  /** A leaf that carries clientAuth only: must be refused as a server identity. */
  readonly clientAuthOnlyCertPath: string;
  readonly clientAuthOnlyKeyPath: string;
  /** A serverAuth leaf whose SAN is not loopback. */
  readonly nonLoopbackServerCertPath: string;
  readonly nonLoopbackServerKeyPath: string;
  /** A serverAuth loopback leaf from a DIFFERENT CA. */
  readonly foreignServerCertPath: string;
  readonly foreignServerKeyPath: string;
  readonly foreignCaPath: string;
  /** CAs outside their own validity window; leaves under them still verify. */
  readonly expiredCaPath: string;
  readonly futureCaPath: string;
  readonly clientFingerprint256: string;
  readonly clientSerial: string;
  readonly clientSubjectAltName: string;
};

type CaWindow = { readonly notBefore?: string; readonly notAfter?: string };

function createCa(root: string, name: string, window: CaWindow = {}): string {
  const caRoot = join(root, name);
  mkdirSync(join(caRoot, 'newcerts'), { recursive: true });
  writeFileSync(join(caRoot, 'index.txt'), '');
  writeFileSync(join(caRoot, 'index.txt.attr'), 'unique_subject = no\n');
  writeFileSync(join(caRoot, 'serial'), '2000\n');
  openssl([
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    ...(window.notBefore === undefined
      ? ['-days', '3650']
      : ['-not_before', window.notBefore, '-not_after', window.notAfter ?? window.notBefore]),
    '-subj', `/CN=${name}`, '-keyout', join(caRoot, 'ca.key'),
    '-out', join(caRoot, 'ca.crt'),
  ]);
  writeFileSync(join(caRoot, 'ca.cnf'), [
    '[ca]', 'default_ca=local_ca', '[local_ca]', `database=${join(caRoot, 'index.txt')}`,
    `serial=${join(caRoot, 'serial')}`, `new_certs_dir=${join(caRoot, 'newcerts')}`,
    `certificate=${join(caRoot, 'ca.crt')}`, `private_key=${join(caRoot, 'ca.key')}`,
    'default_md=sha256', 'policy=subject_policy', 'copy_extensions=copy',
    '[subject_policy]', 'commonName=supplied',
  ].join('\n'));
  return caRoot;
}

type LeafInput = {
  readonly caRoot: string;
  readonly name: string;
  readonly commonName: string;
  readonly eku: string;
  readonly san: string;
};

function issueLeaf(input: LeafInput): { readonly certPath: string; readonly keyPath: string } {
  const keyPath = join(input.caRoot, `${input.name}.key`);
  const csrPath = join(input.caRoot, `${input.name}.csr`);
  const certPath = join(input.caRoot, `${input.name}.crt`);
  const extPath = join(input.caRoot, `${input.name}.ext`);
  writeFileSync(extPath, [
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    `extendedKeyUsage=${input.eku}`,
    `subjectAltName=${input.san}`,
  ].join('\n'));
  openssl([
    'req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-subj', `/CN=${input.commonName}`, '-keyout', keyPath, '-out', csrPath,
  ]);
  openssl([
    'ca', '-batch', '-notext', '-config', join(input.caRoot, 'ca.cnf'),
    '-in', csrPath, '-out', certPath, '-days', '3650', '-extfile', extPath,
  ]);
  chmodSync(keyPath, 0o600);
  return { certPath, keyPath };
}

function fingerprint256(certPath: string): string {
  const output = execFileSync('openssl',
    ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' });
  return output.split('=')[1]?.replaceAll(':', '').trim().toLowerCase() ?? '';
}

function serialOf(certPath: string): string {
  const output = execFileSync('openssl',
    ['x509', '-in', certPath, '-noout', '-serial'], { encoding: 'utf8' });
  return output.split('=')[1]?.trim().toUpperCase() ?? '';
}

export function createJmTlsMaterial(root: string): JmTlsMaterial {
  const trusted = createCa(root, 'Task26-Trusted-CA');
  const foreign = createCa(root, 'Task26-Foreign-CA');
  const expiredCa = createCa(root, 'Task26-Expired-CA', {
    notBefore: '20200101000000Z', notAfter: '20210101000000Z',
  });
  const futureCa = createCa(root, 'Task26-Future-CA', {
    notBefore: '20400101000000Z', notAfter: '20410101000000Z',
  });
  const loopbackSan = 'IP:127.0.0.1,DNS:localhost';
  const server = issueLeaf({
    caRoot: trusted, name: 'server', commonName: 'jm-browser-agent',
    eku: 'serverAuth', san: loopbackSan,
  });
  const otherServer = issueLeaf({
    caRoot: trusted, name: 'server-other', commonName: 'jm-browser-agent-other',
    eku: 'serverAuth', san: loopbackSan,
  });
  const clientAuthOnly = issueLeaf({
    caRoot: trusted, name: 'server-clientauth', commonName: 'jm-browser-agent',
    eku: 'clientAuth', san: loopbackSan,
  });
  const nonLoopback = issueLeaf({
    caRoot: trusted, name: 'server-public', commonName: 'jm-browser-agent',
    eku: 'serverAuth', san: 'DNS:agent.example.invalid',
  });
  const foreignServer = issueLeaf({
    caRoot: foreign, name: 'server-foreign', commonName: 'jm-browser-agent',
    eku: 'serverAuth', san: loopbackSan,
  });
  const clientSan = `URI:urn:sangfor:installation:${JM_INSTALLATION_ID}`;
  const client = issueLeaf({
    caRoot: trusted, name: 'blro-client', commonName: 'blro-control-tower',
    eku: 'clientAuth', san: clientSan,
  });
  const foreignClient = issueLeaf({
    caRoot: foreign, name: 'foreign-client', commonName: 'blro-control-tower',
    eku: 'clientAuth', san: clientSan,
  });
  return {
    caPath: join(trusted, 'ca.crt'),
    foreignCaPath: join(foreign, 'ca.crt'),
    expiredCaPath: join(expiredCa, 'ca.crt'),
    futureCaPath: join(futureCa, 'ca.crt'),
    serverCertPath: server.certPath,
    serverKeyPath: server.keyPath,
    otherServerCertPath: otherServer.certPath,
    otherServerKeyPath: otherServer.keyPath,
    clientAuthOnlyCertPath: clientAuthOnly.certPath,
    clientAuthOnlyKeyPath: clientAuthOnly.keyPath,
    nonLoopbackServerCertPath: nonLoopback.certPath,
    nonLoopbackServerKeyPath: nonLoopback.keyPath,
    foreignServerCertPath: foreignServer.certPath,
    foreignServerKeyPath: foreignServer.keyPath,
    clientCertPath: client.certPath,
    clientKeyPath: client.keyPath,
    foreignClientCertPath: foreignClient.certPath,
    foreignClientKeyPath: foreignClient.keyPath,
    clientFingerprint256: fingerprint256(client.certPath),
    clientSerial: serialOf(client.certPath),
    clientSubjectAltName: `urn:sangfor:installation:${JM_INSTALLATION_ID}`,
  };
}

export type JmSigningMaterial = {
  readonly currentPrivateKey: KeyObject;
  readonly currentPublicKeyPem: string;
  readonly overlapPrivateKey: KeyObject;
  readonly overlapPublicKeyPem: string;
  readonly foreignPrivateKey: KeyObject;
  readonly keyRingPath: string;
};

function pemOf(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

export type KeyRingOverrides = {
  readonly includeOverlap?: boolean;
  readonly overlapNotBefore?: Date;
  readonly overlapNotAfter?: Date;
  readonly currentNotBefore?: Date;
  readonly currentNotAfter?: Date;
  readonly maxOverlapMs?: number;
  readonly extraKeys?: number;
};

export function createJmSigningMaterial(
  root: string,
  overrides: KeyRingOverrides = {},
): JmSigningMaterial {
  const current = generateKeyPairSync('ed25519');
  const overlap = generateKeyPairSync('ed25519');
  const foreign = generateKeyPairSync('ed25519');
  const keyRingPath = join(root, 'verify-key-ring.json');
  const base = new Date();
  const keys: unknown[] = [{
    keyId: CURRENT_KEY_ID,
    role: 'current',
    publicKeyPem: pemOf(current.publicKey),
    notBefore: (overrides.currentNotBefore ?? new Date(base.getTime() - 3_600_000)).toISOString(),
    notAfter: (overrides.currentNotAfter ?? new Date(base.getTime() + 86_400_000)).toISOString(),
  }];
  if (overrides.includeOverlap ?? false) {
    keys.push({
      keyId: OVERLAP_KEY_ID,
      role: 'overlap',
      publicKeyPem: pemOf(overlap.publicKey),
      notBefore: (overrides.overlapNotBefore ?? new Date(base.getTime() - 3_600_000)).toISOString(),
      notAfter: (overrides.overlapNotAfter ?? new Date(base.getTime() + 3_600_000)).toISOString(),
    });
  }
  for (let index = 0; index < (overrides.extraKeys ?? 0); index += 1) {
    keys.push({
      keyId: `extra-${String(index)}`,
      role: 'overlap',
      publicKeyPem: pemOf(generateKeyPairSync('ed25519').publicKey),
      notBefore: new Date(base.getTime() - 1_000).toISOString(),
      notAfter: new Date(base.getTime() + 1_000).toISOString(),
    });
  }
  writeFileSync(keyRingPath, JSON.stringify({
    version: KEY_RING_VERSION,
    maxOverlapMs: overrides.maxOverlapMs ?? 86_400_000,
    keys,
  }, null, 2));
  return {
    currentPrivateKey: current.privateKey,
    currentPublicKeyPem: pemOf(current.publicKey),
    overlapPrivateKey: overlap.privateKey,
    overlapPublicKeyPem: pemOf(overlap.publicKey),
    foreignPrivateKey: foreign.privateKey,
    keyRingPath,
  };
}

export const JM_JOURNAL_GENESIS = createHash('sha256')
  .update('task26-journal-genesis').digest('hex');

export function originDigest(origin: string): string {
  return createHash('sha256').update(`sangfor.origin.v1\u0000${origin}`, 'utf8').digest('hex');
}

export type SnapshotOverrides = {
  readonly issuedAt?: Date;
  readonly expiresAt?: Date;
  readonly state?: 'active' | 'revoked';
  readonly authorityEpoch?: number;
  readonly scopes?: readonly string[];
  readonly originDigests?: readonly string[];
  readonly journalGenesis?: string;
  readonly deviceBindingDigest?: string;
  readonly privateKey?: KeyObject;
};

/** BLRO-side minting; JM only ever verifies these bytes. */
export function buildGrantSnapshot(
  material: JmSigningMaterial,
  overrides: SnapshotOverrides = {},
): string {
  const issuedAt = overrides.issuedAt ?? new Date();
  const snapshot: GrantSnapshot = {
    version: 'blro-enrollment-grant-snapshot.v1',
    snapshotId: `snap-${randomUUID()}`,
    tenantId: JM_TENANT_ID,
    projectId: JM_PROJECT_ID,
    installationId: JM_INSTALLATION_ID,
    clientIdentityId: JM_CLIENT_IDENTITY_ID,
    deviceBindingDigest: overrides.deviceBindingDigest ?? JM_DEVICE_DIGEST,
    authorityEpoch: overrides.authorityEpoch ?? 7,
    state: overrides.state ?? 'active',
    grants: (overrides.originDigests ?? [originDigest(JM_ORIGIN)])
      .flatMap((digest) => (overrides.scopes ?? ['browser:execute'])
        .map((scope) => ({ originDigest: digest, scope }))),
    journalGenesis: overrides.journalGenesis ?? JM_JOURNAL_GENESIS,
    issuedAt: issuedAt.toISOString(),
    expiresAt: (overrides.expiresAt ?? new Date(issuedAt.getTime() + 86_400_000)).toISOString(),
  };
  return signJmAuthorityArtifact(snapshot, overrides.privateKey ?? material.currentPrivateKey);
}

export type ReceiptOverrides = Partial<AuthorityReceipt> & {
  readonly privateKey?: KeyObject;
  /** Forces a reservationDigest that does not match the derived identity. */
  readonly breakReservation?: boolean;
};

/** BLRO-side minting of a per-dispatch receipt bound to one exact request. */
export function buildAuthorityReceipt(
  material: JmSigningMaterial,
  binding: {
    readonly request: BrowserExecutionRequest;
    readonly jobId: string;
    readonly capability: string;
    readonly capabilityJti: string;
    readonly clientFingerprint: string;
  },
  overrides: ReceiptOverrides = {},
): string {
  const issuedAt = overrides.issuedAt ? new Date(overrides.issuedAt) : new Date();
  const receipt: AuthorityReceipt = {
    version: 'blro-authority-receipt.v1',
    receiptId: `receipt-${randomUUID()}`,
    tenantId: JM_TENANT_ID,
    projectId: JM_PROJECT_ID,
    installationId: JM_INSTALLATION_ID,
    deviceBindingDigest: JM_DEVICE_DIGEST,
    origin: JM_ORIGIN,
    authorityEpoch: 7,
    jobId: binding.jobId,
    requestId: binding.request.requestId,
    capabilityJti: binding.capabilityJti,
    requestDigest: browserExecutionRequestDigest(binding.request),
    capabilityDigest: createHash('sha256').update(binding.capability, 'utf8').digest('hex'),
    capabilityVerifyKeyId: CURRENT_KEY_ID,
    capabilityVerifyKeyDigest: publicKeyDigest(material.currentPublicKeyPem),
    clientCertificateFingerprintSha256: binding.clientFingerprint,
    // Derived with the SHARED contract function, exactly as JM will re-derive it.
    reservationDigest: deriveReservationDigest({
      tenantId: JM_TENANT_ID,
      projectId: JM_PROJECT_ID,
      installationId: JM_INSTALLATION_ID,
      deviceBindingDigest: JM_DEVICE_DIGEST,
      authorityEpoch: 7,
      jobId: binding.jobId,
      requestId: binding.request.requestId,
      capabilityJti: binding.capabilityJti,
      requestDigest: browserExecutionRequestDigest(binding.request),
      capabilityDigest: createHash('sha256').update(binding.capability, 'utf8').digest('hex'),
    }),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 600_000).toISOString(),
    ...overrides,
  };
  const { privateKey, breakReservation, ...merged } = { ...receipt, ...overrides };
  const claim = breakReservation === true
    ? { ...merged, reservationDigest: createHash('sha256').update('wrong').digest('hex') }
    : merged;
  return signJmAuthorityArtifact(claim, overrides.privateKey ?? material.currentPrivateKey);
}

export function browserRequest(
  overrides: Partial<BrowserExecutionRequest> = {},
): BrowserExecutionRequest {
  return {
    schemaVersion: 'browser-execution-request.v1',
    requestId: `req-${randomUUID()}`,
    sessionId: JM_SESSION_ID,
    origin: JM_ORIGIN,
    operation: { kind: 'observe_console', includeSnapshot: false },
    ...overrides,
  } as BrowserExecutionRequest;
}

export type CapabilityOverrides = {
  readonly jti?: string;
  readonly authorityEpoch?: number;
  readonly expiresAt?: Date;
  readonly issuedAt?: Date;
  readonly jobId?: string;
  readonly privateKey?: KeyObject;
};

export function mintTaskCapability(
  material: JmSigningMaterial,
  request: BrowserExecutionRequest,
  overrides: CapabilityOverrides = {},
): string {
  const issuedAt = overrides.issuedAt ?? new Date();
  return mintJobCapability({
    tenantId: JM_TENANT_ID,
    projectId: JM_PROJECT_ID,
    authorityEpoch: overrides.authorityEpoch ?? 7,
    runId: request.sessionId,
    stepId: request.requestId,
    jobId: overrides.jobId ?? request.requestId,
    clientIdentityId: JM_CLIENT_IDENTITY_ID,
    installationId: JM_INSTALLATION_ID,
    request,
    issuedAt,
    expiresAt: overrides.expiresAt ?? new Date(issuedAt.getTime() + 60_000),
    jti: overrides.jti ?? `jti-${randomUUID()}`,
    privateKey: overrides.privateKey ?? material.currentPrivateKey,
  });
}

export type FakeExecutionPort = JmExecutionPort & {
  readonly calls: () => number;
  readonly closes: () => number;
};

/**
 * TESTS ONLY. Establishes a journal exactly as the operator CLI would: 0700
 * root, 0600 file, canonical signed-grant-bound header, durable append. It is
 * never imported by the app or the package.
 */
export function initialiseTestJournal(root: string, header: {
  readonly journalEpoch: number;
  readonly genesisDigest: string;
}): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = join(root, JOURNAL_FILE_NAME);
  createJournalExclusively(path);
  appendDurably(path, journalHeaderLine({
    kind: JOURNAL_HEADER_KIND,
    tenantId: JM_TENANT_ID,
    projectId: JM_PROJECT_ID,
    installationId: JM_INSTALLATION_ID,
    deviceBindingDigest: JM_DEVICE_DIGEST,
    journalEpoch: header.journalEpoch,
    genesisDigest: header.genesisDigest,
  }));
  return path;
}

/**
 * TESTS ONLY. Travels the same typed JmExecutionPort seam production uses, so a
 * test never takes a different runtime path. It lives here and is not importable
 * by the app or the package.
 */
export function createFakeExecutionPort(options: {
  readonly hold?: () => Promise<void>;
  readonly ignoreAbort?: boolean;
  /** Drives the SAME ongoing seam production readiness calls. */
  readonly preflight?: () => ExecutionPreflight;
  /** Drives the SAME startup seam, including the bind probe. */
  readonly startupPreflight?: (bind: { readonly host: string; readonly port: number })
    => Promise<ExecutionPreflight>;
} = {}): FakeExecutionPort {
  let calls = 0;
  let closes = 0;
  return {
    calls: () => calls,
    closes: () => closes,
    // Both phases exist on the fake exactly as they do in production.
    startupPreflight: async (bind) => (options.startupPreflight
      ? options.startupPreflight(bind)
      : options.preflight?.() ?? { ok: true }),
    readinessPreflight: () => options.preflight?.() ?? { ok: true },
    async execute(request, context): Promise<BrowserExecutionResult> {
      calls += 1;
      if (options.hold) await options.hold();
      if (context.signal.aborted && !options.ignoreAbort) {
        return {
          schemaVersion: 'browser-execution-result.v1',
          requestId: request.requestId,
          status: 'INDETERMINATE',
          mutationAttempted: true,
          readBack: { status: 'INDETERMINATE' },
          observations: {},
          evidence: [],
          error: { code: 'JM_EXECUTION_ABORTED', message: 'Aborted before completion.' },
        };
      }
      return {
        schemaVersion: 'browser-execution-result.v1',
        requestId: request.requestId,
        status: 'INDETERMINATE',
        mutationAttempted: false,
        readBack: { status: 'INDETERMINATE' },
        observations: {},
        evidence: [],
        error: { code: 'JM_FAKE_EXECUTION', message: 'Fake executor asserts no outcome.' },
      };
    },
    async close(): Promise<void> {
      closes += 1;
    },
  };
}

export function readKeyRing(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
