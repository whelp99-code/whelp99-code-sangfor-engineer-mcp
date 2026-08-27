import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KeyRing,
  RefusalJournal,
  RefusalJournalError,
  canonicalizeAllowedOrigin,
  checkServerIdentity,
  grantSnapshotSchema,
  parseBlroSanUri,
  JOURNAL_HEADER_KIND,
  parseJmAgentConfig,
  publicKeyDigest,
  verifyAuthorityReceipt,
  verifyGrantSnapshot,
  type JmAgentEnvironment,
  type JournalReservationInput,
} from '../packages/sangfor-jm-agent/src/index.js';
import {
  browserExecutionRequestDigest,
  deriveReservationDigest,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  CURRENT_KEY_ID,
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
  createJmSigningMaterial,
  createJmTlsMaterial,
  mintTaskCapability,
  originDigest,
  initialiseTestJournal,
  readKeyRing,
  type JmSigningMaterial,
  type JmTlsMaterial,
} from './helpers/jm-agent-fixture.js';

let root: string;
let tls: JmTlsMaterial;
let signing: JmSigningMaterial;
let snapshotPath: string;
let profileRoot: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jm-agent-'));
  tls = createJmTlsMaterial(root);
  signing = createJmSigningMaterial(root);
  profileRoot = join(root, 'profile');
  mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  chmodSync(profileRoot, 0o700);
  snapshotPath = join(root, 'grant-snapshot.jws');
  writeFileSync(snapshotPath, buildGrantSnapshot(signing));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function baseEnvironment(): Record<string, string> {
  return {
    SANGFOR_JM_AGENT_BIND_HOST: '127.0.0.1',
    SANGFOR_JM_AGENT_PORT: '39443',
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
    SANGFOR_JM_AGENT_JOURNAL_ROOT: join(root, 'journal'),
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
    SANGFOR_JM_AGENT_DRAIN_DEADLINE_MS: '10000',
    SANGFOR_JM_AGENT_SNAPSHOT_MAX_AGE_MS: '900000',
  };
}

function parse(overrides: Record<string, string | undefined> = {}) {
  return parseJmAgentConfig({ ...baseEnvironment(), ...overrides } as JmAgentEnvironment);
}

describe('JM agent configuration boundary', () => {
  it('accepts a complete operated loopback configuration', () => {
    const result = parse();

    expect(result.success, JSON.stringify(result.success ? [] : result.issues)).toBe(true);
    if (!result.success) return;
    expect(result.data.bindHost).toBe('127.0.0.1');
    expect(result.data.browserProfileRef).toBe('task26-profile');
  });

  it('has no execution-mode field at all and refuses every mock switch', () => {
    // Given the shipped field set. Then no mode/mock field exists.
    expect(Object.keys(baseEnvironment())).not.toContain('SANGFOR_JM_AGENT_EXECUTION_MODE');

    // When a leftover mock switch is present. Then startup is refused by name.
    for (const field of [
      'SANGFOR_JM_AGENT_EXECUTION_MODE',
      'SANGFOR_JM_AGENT_MOCK',
      'SANGFOR_JM_AGENT_MOCK_EXECUTION',
      'SANGFOR_JM_AGENT_USE_MOCK',
    ]) {
      const result = parse({ [field]: 'mock' });
      expect(result.success, field).toBe(false);
      if (result.success) continue;
      expect(result.issues.some((issue) => (
        issue.field === field && issue.code === 'CONFIG_FIELD_FORBIDDEN'
      )), field).toBe(true);
    }
  });

  it('refuses every missing required field by name', () => {
    for (const field of Object.keys(baseEnvironment())) {
      const result = parse({ [field]: undefined });
      expect(result.success, `${field} must be required`).toBe(false);
      if (result.success) continue;
      expect(result.issues.map((issue) => issue.field)).toContain(field);
    }
  });

  it('refuses unknown extra configuration fields', () => {
    const result = parse({ SANGFOR_JM_AGENT_UNKNOWN_EXTRA: 'x' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.some((issue) => issue.code === 'CONFIG_FIELD_UNKNOWN')).toBe(true);
  });

  it('refuses a non-loopback bind host', () => {
    for (const host of ['0.0.0.0', '10.0.0.5', '::']) {
      expect(parse({ SANGFOR_JM_AGENT_BIND_HOST: host }).success, host).toBe(false);
    }
  });

  it('refuses a world-readable private key and a symlinked material path', () => {
    const loose = join(root, 'loose.key');
    writeFileSync(loose, readFileSync(tls.serverKeyPath));
    chmodSync(loose, 0o644);
    const link = join(root, 'linked-ca.crt');
    rmSync(link, { force: true });
    symlinkSync(tls.caPath, link);

    const weak = parse({ SANGFOR_JM_AGENT_TLS_KEY_PATH: loose });
    const symlinked = parse({ SANGFOR_JM_AGENT_TLS_CLIENT_CA_PATH: link });

    expect(weak.success).toBe(false);
    expect(symlinked.success).toBe(false);
    if (!weak.success) expect(weak.issues.map((i) => i.code)).toContain('KEY_PERMISSIONS_WEAK');
    if (!symlinked.success) {
      expect(symlinked.issues.map((i) => i.code)).toContain('PATH_NOT_REGULAR_FILE');
    }
  });

  it('never echoes private key or certificate bytes in issues', () => {
    const loose = join(root, 'leaky.key');
    writeFileSync(loose, readFileSync(tls.serverKeyPath));
    chmodSync(loose, 0o644);

    const serialized = JSON.stringify(parse({ SANGFOR_JM_AGENT_TLS_KEY_PATH: loose }));

    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('BEGIN CERTIFICATE');
  });
});

describe('TLS server identity, origin and SAN parsing', () => {
  // openssl stamps notBefore at whole-second granularity, so a wall-clock `now`
  // captured in the same second can fall microseconds BEFORE the certificate
  // becomes valid. Evaluate a minute later: still inside the 10-year window,
  // but never racing the mint boundary.
  const now = new Date(Date.now() + 60_000);

  it('accepts the CA-signed serverAuth loopback leaf that matches its key', () => {
    expect(checkServerIdentity({
      certPath: tls.serverCertPath, keyPath: tls.serverKeyPath, caPath: tls.caPath, now,
    }).ok).toBe(true);
  });

  it('refuses clientAuth-only, non-loopback SAN, foreign CA and key mismatch distinctly', () => {
    const cases = [
      {
        input: { certPath: tls.clientAuthOnlyCertPath, keyPath: tls.clientAuthOnlyKeyPath, caPath: tls.caPath },
        reason: 'SERVER_CERT_EKU_NOT_SERVER_AUTH',
      },
      {
        input: { certPath: tls.nonLoopbackServerCertPath, keyPath: tls.nonLoopbackServerKeyPath, caPath: tls.caPath },
        reason: 'SERVER_CERT_SAN_NOT_LOOPBACK',
      },
      {
        input: { certPath: tls.foreignServerCertPath, keyPath: tls.foreignServerKeyPath, caPath: tls.caPath },
        reason: 'SERVER_CERT_NOT_ISSUED_BY_CA',
      },
      {
        input: { certPath: tls.serverCertPath, keyPath: tls.otherServerKeyPath, caPath: tls.caPath },
        reason: 'SERVER_CERT_KEY_MISMATCH',
      },
    ];

    for (const testCase of cases) {
      const decision = checkServerIdentity({ ...testCase.input, now });
      expect(decision.ok, testCase.reason).toBe(false);
      if (decision.ok) continue;
      expect(decision.reason).toBe(testCase.reason);
    }
  });

  it('canonicalizes allowed origins to https origin only', () => {
    expect(canonicalizeAllowedOrigin('https://a.test')).toBe('https://a.test');
    expect(canonicalizeAllowedOrigin('  https://a.test  ')).toBe('https://a.test');
    // The shared origin contract is origin-ONLY: even a bare trailing slash is a
    // path and is refused, so operators cannot configure two spellings of one origin.
    for (const bad of [
      'https://a.test/', 'https://a.test/path', 'https://a.test/?q=1', 'https://a.test/#f',
      'https://user:pass@a.test', 'http://a.test', 'ftp://a.test', 'not-a-url',
    ]) {
      expect(canonicalizeAllowedOrigin(bad), bad).toBeUndefined();
    }
  });

  it('strictly parses the configured BLRO SAN URI', () => {
    expect(parseBlroSanUri(`urn:sangfor:installation:${JM_INSTALLATION_ID}`))
      .toBe(`urn:sangfor:installation:${JM_INSTALLATION_ID}`);
    for (const bad of [
      'urn:sangfor:installation:', 'urn:sangfor:device:x', 'installation:x',
      'urn:sangfor:installation:a/../b', '',
    ]) {
      expect(parseBlroSanUri(bad), bad).toBeUndefined();
    }
  });
});

describe('bounded verification key ring', () => {
  const now = new Date();

  it('resolves the current key and reports its digest', () => {
    const ring = KeyRing.load(readKeyRing(signing.keyRingPath));
    expect(ring.ok).toBe(true);
    if (!ring.ok) return;

    const resolved = ring.ring.resolve(CURRENT_KEY_ID, now);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.digest).toBe(publicKeyDigest(signing.currentPublicKeyPem));
  });

  it('refuses unknown, stale, future and extra keys', () => {
    const ring = KeyRing.load(readKeyRing(signing.keyRingPath));
    expect(ring.ok).toBe(true);
    if (!ring.ok) return;
    expect(ring.ring.resolve('nope', now)).toMatchObject({ reason: 'KEY_RING_KEY_UNKNOWN' });

    const stale = createJmSigningMaterial(mkdtempSync(join(tmpdir(), 'ring-stale-')), {
      currentNotBefore: new Date(now.getTime() - 7_200_000),
      currentNotAfter: new Date(now.getTime() - 3_600_000),
    });
    const staleRing = KeyRing.load(readKeyRing(stale.keyRingPath));
    expect(staleRing.ok && staleRing.ring.resolve(CURRENT_KEY_ID, now))
      .toMatchObject({ reason: 'KEY_RING_KEY_STALE' });

    const future = createJmSigningMaterial(mkdtempSync(join(tmpdir(), 'ring-future-')), {
      currentNotBefore: new Date(now.getTime() + 3_600_000),
      currentNotAfter: new Date(now.getTime() + 7_200_000),
    });
    const futureRing = KeyRing.load(readKeyRing(future.keyRingPath));
    expect(futureRing.ok && futureRing.ring.resolve(CURRENT_KEY_ID, now))
      .toMatchObject({ reason: 'KEY_RING_KEY_FUTURE' });

    const extra = createJmSigningMaterial(mkdtempSync(join(tmpdir(), 'ring-extra-')), {
      includeOverlap: true, extraKeys: 1,
    });
    expect(KeyRing.load(readKeyRing(extra.keyRingPath))).toMatchObject({ ok: false });
  });

  it('permits exactly one overlap key and refuses an overlong overlap', () => {
    const good = createJmSigningMaterial(mkdtempSync(join(tmpdir(), 'ring-ok-')), {
      includeOverlap: true,
    });
    expect(KeyRing.load(readKeyRing(good.keyRingPath)).ok).toBe(true);

    const tooLong = createJmSigningMaterial(mkdtempSync(join(tmpdir(), 'ring-long-')), {
      includeOverlap: true,
      maxOverlapMs: 1_000,
      overlapNotBefore: new Date(now.getTime() - 3_600_000),
      overlapNotAfter: new Date(now.getTime() + 3_600_000),
    });
    expect(KeyRing.load(readKeyRing(tooLong.keyRingPath)))
      .toMatchObject({ reason: 'KEY_RING_OVERLAP_TOO_LONG' });
  });
});

describe('grant snapshot verification', () => {
  // Evaluated strictly after minting, so validity is decided by the fixture's
  // own offsets rather than by which side of a millisecond boundary we land on.
  const now = new Date(Date.now() + 1_000);
  const expected = {
    tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID, installationId: JM_INSTALLATION_ID,
  };

  it('accepts a signed active snapshot and reports revoked/expired distinctly', () => {
    const cases = [
      { snapshot: buildGrantSnapshot(signing), ok: true, reason: undefined },
      {
        snapshot: buildGrantSnapshot(signing, { state: 'revoked' }),
        ok: false, reason: 'SNAPSHOT_ENROLLMENT_REVOKED',
      },
      {
        snapshot: buildGrantSnapshot(signing, {
          issuedAt: new Date(now.getTime() - 7_200_000),
          expiresAt: new Date(now.getTime() - 3_600_000),
        }),
        ok: false, reason: 'SNAPSHOT_EXPIRED',
      },
      {
        snapshot: buildGrantSnapshot(signing, { privateKey: signing.foreignPrivateKey }),
        ok: false, reason: 'SNAPSHOT_SIGNATURE_INVALID',
      },
    ];

    for (const testCase of cases) {
      const decision = verifyGrantSnapshot({
        snapshot: testCase.snapshot,
        publicKeyPem: signing.currentPublicKeyPem,
        expected,
        now,
      });
      expect(decision.ok, testCase.reason ?? 'active').toBe(testCase.ok);
      if (!decision.ok && testCase.reason) expect(decision.reason).toBe(testCase.reason);
    }
  });
});

describe('per-dispatch authority receipt binding', () => {
  // Evaluated strictly after minting; see the note in the snapshot suite.
  const now = new Date(Date.now() + 1_000);

  function bound(overrides: Parameters<typeof buildAuthorityReceipt>[2] = {}) {
    const request = browserRequest();
    const jti = `jti-binding-${randomUUID()}`;
    const capability = mintTaskCapability(signing, request, { jti });
    const receipt = buildAuthorityReceipt(signing, {
      request, jobId: request.requestId, capability, capabilityJti: jti,
      clientFingerprint: tls.clientFingerprint256,
    }, overrides);
    return { request, capability, jti, receipt };
  }

  /** The expectation JM builds from the ACTUAL request, never from the receipt. */
  function expectationFor(input: ReturnType<typeof bound>, receiptId: string) {
    const capabilityDigest = createHash('sha256')
      .update(input.capability, 'utf8').digest('hex');
    return {
      receiptId,
      tenantId: JM_TENANT_ID,
      projectId: JM_PROJECT_ID,
      installationId: JM_INSTALLATION_ID,
      deviceBindingDigest: JM_DEVICE_DIGEST,
      authorityEpoch: 7,
      origin: JM_ORIGIN,
      jobId: input.request.requestId,
      requestId: input.request.requestId,
      capabilityJti: input.jti,
      requestDigest: browserExecutionRequestDigest(input.request),
      capabilityDigest,
      capabilityVerifyKeyId: CURRENT_KEY_ID,
      capabilityVerifyKeyDigest: publicKeyDigest(signing.currentPublicKeyPem),
      clientCertificateFingerprintSha256: tls.clientFingerprint256,
    };
  }

  function receiptIdOf(encoded: string): string {
    const payload = encoded.split('.')[0] ?? '';
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return (decoded as { readonly receiptId: string }).receiptId;
  }

  it('derives the reservation digest identically on both sides', () => {
    // Given the same identity, When each side derives, Then the digests match.
    const identity = {
      tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID, installationId: JM_INSTALLATION_ID,
      deviceBindingDigest: JM_DEVICE_DIGEST, authorityEpoch: 7,
      jobId: 'job-a', requestId: 'req-a', capabilityJti: 'jti-a',
      requestDigest: 'a'.repeat(64), capabilityDigest: 'b'.repeat(64),
    };

    expect(deriveReservationDigest(identity)).toBe(deriveReservationDigest({ ...identity }));
  });

  it('gives a different reservation digest for every changed identity field', () => {
    const base = {
      tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID, installationId: JM_INSTALLATION_ID,
      deviceBindingDigest: JM_DEVICE_DIGEST, authorityEpoch: 7,
      jobId: 'job-a', requestId: 'req-a', capabilityJti: 'jti-a',
      requestDigest: 'a'.repeat(64), capabilityDigest: 'b'.repeat(64),
    };
    const baseline = deriveReservationDigest(base);
    const variants: readonly Partial<typeof base>[] = [
      { tenantId: 'other' }, { projectId: 'other' }, { installationId: 'other' },
      { deviceBindingDigest: 'c'.repeat(64) }, { authorityEpoch: 8 },
      { jobId: 'job-b' }, { requestId: 'req-b' }, { capabilityJti: 'jti-b' },
      { requestDigest: 'd'.repeat(64) }, { capabilityDigest: 'e'.repeat(64) },
    ];

    for (const variant of variants) {
      expect(deriveReservationDigest({ ...base, ...variant }), JSON.stringify(variant))
        .not.toBe(baseline);
    }
  });

  it('accepts a receipt whose every binding matches the request', () => {
    const input = bound();

    const decision = verifyAuthorityReceipt({
      receipt: input.receipt,
      publicKeyPem: signing.currentPublicKeyPem,
      expected: expectationFor(input, receiptIdOf(input.receipt)),
      now,
    });

    expect(decision.ok, decision.ok ? '' : decision.reason).toBe(true);
  });

  // Mutating each of the 18 receipt fields in turn must produce a refusal.
  it('refuses a mutation of every one of the 18 receipt fields', () => {
    const other = createHash('sha256').update('other').digest('hex');
    const cases: readonly { readonly field: string; readonly patch: Record<string, unknown> }[] = [
      { field: 'version', patch: { version: 'blro-authority-receipt.v2' } },
      { field: 'receiptId', patch: { receiptId: 'receipt-other' } },
      { field: 'tenantId', patch: { tenantId: 'other-tenant' } },
      { field: 'projectId', patch: { projectId: 'other-project' } },
      { field: 'installationId', patch: { installationId: 'other-install' } },
      { field: 'deviceBindingDigest', patch: { deviceBindingDigest: other } },
      { field: 'origin', patch: { origin: 'https://evil.invalid' } },
      { field: 'authorityEpoch', patch: { authorityEpoch: 9 } },
      { field: 'jobId', patch: { jobId: 'other-job' } },
      { field: 'requestId', patch: { requestId: 'other-request' } },
      { field: 'capabilityJti', patch: { capabilityJti: 'other-jti' } },
      { field: 'requestDigest', patch: { requestDigest: other } },
      { field: 'capabilityDigest', patch: { capabilityDigest: other } },
      { field: 'capabilityVerifyKeyId', patch: { capabilityVerifyKeyId: 'other-key' } },
      { field: 'capabilityVerifyKeyDigest', patch: { capabilityVerifyKeyDigest: other } },
      { field: 'clientCertificateFingerprintSha256', patch: { clientCertificateFingerprintSha256: other } },
      { field: 'reservationDigest', patch: { breakReservation: true } },
      { field: 'expiresAt', patch: { expiresAt: new Date(now.getTime() - 60_000).toISOString() } },
    ];
    expect(cases).toHaveLength(18);

    for (const testCase of cases) {
      const clean = bound();
      const mutated = bound(testCase.patch as Parameters<typeof buildAuthorityReceipt>[2]);
      const decision = verifyAuthorityReceipt({
        receipt: mutated.receipt,
        publicKeyPem: signing.currentPublicKeyPem,
        // The expectation is built from the clean request scope, and the
        // announced receiptId comes from the mutated receipt only for the
        // receiptId case so the other 17 isolate their own field.
        expected: {
          ...expectationFor(mutated, testCase.field === 'receiptId'
            ? receiptIdOf(clean.receipt)
            : receiptIdOf(mutated.receipt)),
          ...(testCase.field === 'version' ? {} : {}),
        },
        now,
      });

      expect(decision.ok, `${testCase.field} must be refused`).toBe(false);
    }
  });

  it('refuses a receipt signed by a foreign key', () => {
    const input = bound({ privateKey: signing.foreignPrivateKey });

    const decision = verifyAuthorityReceipt({
      receipt: input.receipt,
      publicKeyPem: signing.currentPublicKeyPem,
      expected: expectationFor(input, receiptIdOf(input.receipt)),
      now,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe('RECEIPT_SIGNATURE_INVALID');
  });

  it('refuses a reservation digest that does not match the derived identity', () => {
    const input = bound({ breakReservation: true });

    const decision = verifyAuthorityReceipt({
      receipt: input.receipt,
      publicKeyPem: signing.currentPublicKeyPem,
      expected: expectationFor(input, receiptIdOf(input.receipt)),
      now,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe('RECEIPT_RESERVATION_MISMATCH');
  });

  it('refuses a receiptId that was not the one announced out of band', () => {
    const input = bound();

    const decision = verifyAuthorityReceipt({
      receipt: input.receipt,
      publicKeyPem: signing.currentPublicKeyPem,
      expected: { ...expectationFor(input, 'receipt-announced-elsewhere') },
      now,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe('RECEIPT_ID_MISMATCH');
  });
});

describe('durable refusal journal keyed by scoped job identity', () => {
  const header = { journalEpoch: 7, genesisDigest: JM_JOURNAL_GENESIS };

  function freshJournal(name: string) {
    const journalRoot = join(mkdtempSync(join(tmpdir(), `journal-${name}-`)), 'jm');
    const path = initialiseTestJournal(journalRoot, header);
    return { journalRoot, path };
  }

  function open(path: string) {
    return RefusalJournal.open({
      path,
      expected: {
        kind: JOURNAL_HEADER_KIND,
        tenantId: JM_TENANT_ID,
        projectId: JM_PROJECT_ID,
        installationId: JM_INSTALLATION_ID,
        deviceBindingDigest: JM_DEVICE_DIGEST,
        journalEpoch: header.journalEpoch,
        genesisDigest: header.genesisDigest,
      },
    });
  }

  function row(overrides: Partial<JournalReservationInput> = {}): JournalReservationInput {
    return {
      jobId: 'job-1', receiptId: 'receipt-1', requestId: 'req-1', capabilityJti: 'jti-1',
      requestDigest: 'a'.repeat(64), capabilityDigest: 'b'.repeat(64),
      reservationDigest: 'c'.repeat(64),
      ...overrides,
    };
  }

  it('reserves once and refuses the identical reservation after restart', () => {
    const { path } = freshJournal('restart');
    expect(open(path).reserve(row(), new Date()).kind).toBe('reserved');

    // A brand-new instance reading the SAME file must still refuse.
    expect(open(path).reserve(row(), new Date()).kind).toBe('duplicate');
  });

  it('refuses the same job under a BRAND NEW receipt and JTI', () => {
    const { path } = freshJournal('newreceipt');
    const journal = open(path);
    journal.reserve(row(), new Date());

    // Same scoped job, everything else fresh: still refused, never dispatched.
    const outcome = journal.reserve(row({
      receiptId: 'receipt-2', requestId: 'req-2', capabilityJti: 'jti-2',
      requestDigest: 'd'.repeat(64), reservationDigest: 'e'.repeat(64),
    }), new Date());

    expect(outcome.kind).toBe('conflict');
  });

  it('refuses the same JTI spent across any other job', () => {
    const { path } = freshJournal('jti');
    const journal = open(path);
    journal.reserve(row(), new Date());

    const outcome = journal.reserve(row({ jobId: 'job-2', receiptId: 'receipt-2' }), new Date());

    expect(outcome.kind).toBe('conflict');
  });

  it('allows multiple DISTINCT jobs sequentially', () => {
    const { path } = freshJournal('sequential');
    const journal = open(path);

    for (let index = 0; index < 5; index += 1) {
      expect(journal.reserve(row({
        jobId: `job-${String(index)}`,
        receiptId: `receipt-${String(index)}`,
        requestId: `req-${String(index)}`,
        capabilityJti: `jti-${String(index)}`,
        requestDigest: createHash('sha256').update(String(index)).digest('hex'),
      }), new Date()).kind, `job ${String(index)}`).toBe('reserved');
    }
    expect(journal.length).toBe(5);
  });

  it('NEVER auto-creates a root, a file, or a header', () => {
    const missingRoot = join(mkdtempSync(join(tmpdir(), 'journal-none-')), 'absent');

    expect(() => RefusalJournal.open({
      path: join(missingRoot, 'refusals.jsonl'),
      expected: {
        kind: JOURNAL_HEADER_KIND, tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID,
        installationId: JM_INSTALLATION_ID, deviceBindingDigest: JM_DEVICE_DIGEST,
        journalEpoch: 7, genesisDigest: JM_JOURNAL_GENESIS,
      },
    })).toThrow(RefusalJournalError);
    expect(existsSync(missingRoot)).toBe(false);
  });

  it('refuses an insecure root or file mode, and a symlinked file', () => {
    const { journalRoot, path } = freshJournal('modes');
    chmodSync(journalRoot, 0o755);
    expect(() => open(path)).toThrow(RefusalJournalError);
    chmodSync(journalRoot, 0o700);

    chmodSync(path, 0o644);
    expect(() => open(path)).toThrow(RefusalJournalError);
    chmodSync(path, 0o600);

    const link = join(journalRoot, 'linked.jsonl');
    symlinkSync(path, link);
    expect(() => open(link)).toThrow(RefusalJournalError);
  });

  it('refuses a missing header, an empty replacement and a truncated chain', () => {
    const { path } = freshJournal('corrupt');
    const journal = open(path);
    journal.reserve(row(), new Date());
    const original = readFileSync(path, 'utf8');

    // Empty replacement of an established journal.
    writeFileSync(path, '', { mode: 0o600 });
    expect(() => open(path)).toThrow(RefusalJournalError);

    // Header removed.
    writeFileSync(path, original.split('\n').slice(1).join('\n'), { mode: 0o600 });
    expect(() => open(path)).toThrow(RefusalJournalError);

    // Hash-chain corruption.
    writeFileSync(path, original.replace('receipt-1', 'receipt-X'), { mode: 0o600 });
    expect(() => open(path)).toThrow(RefusalJournalError);

    writeFileSync(path, original, { mode: 0o600 });
    expect(open(path).length).toBe(1);
  });

  it('refuses a journal whose header names another grant epoch or genesis', () => {
    const { path } = freshJournal('epoch');

    for (const wrong of [
      { kind: JOURNAL_HEADER_KIND, tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID,
        installationId: JM_INSTALLATION_ID, deviceBindingDigest: JM_DEVICE_DIGEST,
        journalEpoch: 8, genesisDigest: JM_JOURNAL_GENESIS },
      { kind: JOURNAL_HEADER_KIND, tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID,
        installationId: JM_INSTALLATION_ID, deviceBindingDigest: JM_DEVICE_DIGEST,
        journalEpoch: 7, genesisDigest: 'f'.repeat(64) },
    ] as const) {
      try {
        RefusalJournal.open({ path, expected: wrong });
        expect.unreachable('a foreign epoch or genesis must refuse');
      } catch (error) {
        expect(error).toBeInstanceOf(RefusalJournalError);
        expect((error as RefusalJournalError).reason).toBe('JOURNAL_GENESIS_MISMATCH');
      }
    }
  });

  it('records the post-dispatch observation without producing a verdict', () => {
    const { path } = freshJournal('observation');
    const journal = open(path);
    journal.reserve(row(), new Date());

    journal.recordIndeterminate(row(), new Date());

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] ?? '{}')).toMatchObject({ state: 'indeterminate' });
    expect(readFileSync(path, 'utf8')).not.toContain('PASS');
  });
});

describe('journal append is TOCTOU-safe and never recreates a file', () => {
  const header = { journalEpoch: 7, genesisDigest: JM_JOURNAL_GENESIS };

  function established(name: string) {
    const journalRoot = join(mkdtempSync(join(tmpdir(), `toctou-${name}-`)), 'jm');
    const path = initialiseTestJournal(journalRoot, header);
    return { journalRoot, path };
  }

  function openJournal(path: string) {
    return RefusalJournal.open({
      path,
      expected: {
        kind: JOURNAL_HEADER_KIND, tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID,
        installationId: JM_INSTALLATION_ID, deviceBindingDigest: JM_DEVICE_DIGEST,
        journalEpoch: header.journalEpoch, genesisDigest: header.genesisDigest,
      },
    });
  }

  const reservation: JournalReservationInput = {
    jobId: 'job-toctou', receiptId: 'receipt-toctou', requestId: 'req-toctou',
    capabilityJti: 'jti-toctou', requestDigest: 'a'.repeat(64),
    capabilityDigest: 'b'.repeat(64), reservationDigest: 'c'.repeat(64),
  };

  it('uses no O_CREAT and no append shorthand anywhere in the storage module', () => {
    const storage = readFileSync(
      join(import.meta.dirname, '../packages/sangfor-jm-agent/src/journal-storage.ts'), 'utf8',
    );

    // The production append must never be able to bring a file back. Scope the
    // scan to appendDurably's own body: createJournalExclusively is the single
    // operator-only creator and is allowed to use O_CREAT.
    expect(storage).toContain('O_NOFOLLOW');
    expect(storage).not.toMatch(/openSync\([^,]+,\s*'a'\)/u);
    const start = storage.indexOf('export function appendDurably');
    // Strip comments: the doc block names O_CREAT precisely to explain its absence.
    const appendBody = storage
      .slice(start, storage.indexOf('\nfunction openRefusal', start))
      .replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');
    expect(appendBody).not.toContain('O_CREAT');
    expect(appendBody).toContain('APPEND_FLAGS');
    // And the flags constant itself excludes O_CREAT.
    const flags = storage.slice(storage.indexOf('const APPEND_FLAGS'));
    expect(flags.slice(0, flags.indexOf(';'))).not.toContain('O_CREAT');
  });

  it('BARRIER before open: a deletion between lstat and open refuses and recreates nothing', () => {
    const { path } = established('before-open');
    const journal = openJournal(path);

    // Given the file is removed at the exact moment before the append opens it.
    rmSync(path);
    let refusal: unknown;
    try {
      journal.reserve(reservation, new Date());
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(RefusalJournalError);
    expect((refusal as RefusalJournalError).reason).toBe('JOURNAL_NOT_ESTABLISHED');
    // Then no file was recreated by the failed append.
    expect(existsSync(path), 'fileRecreated').toBe(false);
  });

  it('BARRIER after open: a replacement between open and completion refuses', () => {
    const { path } = established('after-open');
    const journal = openJournal(path);
    const original = readFileSync(path, 'utf8');

    // Given the path is REPLACED by a different inode while the append is armed.
    rmSync(path);
    writeFileSync(path, original, { mode: 0o600 });

    let refusal: unknown;
    try {
      journal.reserve(reservation, new Date());
    } catch (error) {
      refusal = error;
    }

    // Then the replacement is detected: the reservation never lands on it.
    expect(refusal).toBeInstanceOf(RefusalJournalError);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('refuses a symlink swapped in for the journal file', () => {
    const { journalRoot, path } = established('symlink');
    const journal = openJournal(path);
    const decoy = join(journalRoot, 'decoy.jsonl');
    writeFileSync(decoy, readFileSync(path, 'utf8'), { mode: 0o600 });
    rmSync(path);
    symlinkSync(decoy, path);

    expect(() => journal.reserve(reservation, new Date())).toThrow(RefusalJournalError);
  });

  it('reserveAfterLoss is REFUSED, the executor never runs, and no file reappears', async () => {
    const { path } = established('afterloss');
    const journal = openJournal(path);
    const ring = KeyRing.load(readKeyRing(signing.keyRingPath));
    expect(ring.ok).toBe(true);
    if (!ring.ok) return;

    const { createReceiptRemoteJobStore } =
      await import('../packages/sangfor-jm-agent/src/index.js');
    const { buildRemoteJobEnvelope } =
      await import('../packages/sangfor-browser-contracts/src/index.js');
    const request = browserRequest();
    const jti = `jti-loss-${randomUUID()}`;
    const capability = mintTaskCapability(signing, request, { jti });
    const envelope = buildRemoteJobEnvelope(request, {
      tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID, capability,
    });
    const receipt = buildAuthorityReceipt(signing, {
      request, jobId: envelope.jobId, capability, capabilityJti: jti,
      clientFingerprint: tls.clientFingerprint256,
    });
    const receiptId = (JSON.parse(Buffer.from(
      receipt.split('.')[0] ?? '', 'base64url',
    ).toString('utf8')) as { readonly receiptId: string }).receiptId;
    const snapshot = grantSnapshotSchema.parse({
      version: 'blro-enrollment-grant-snapshot.v1', snapshotId: 's',
      tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID, installationId: JM_INSTALLATION_ID,
      clientIdentityId: 'c', deviceBindingDigest: JM_DEVICE_DIGEST, authorityEpoch: 7,
      state: 'active',
      grants: [{ originDigest: originDigest(JM_ORIGIN), scope: 'browser:execute' }],
      journalGenesis: JM_JOURNAL_GENESIS,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const store = createReceiptRemoteJobStore({
      receiptFor: () => receipt,
      receiptIdFor: () => receiptId,
      clientFingerprintFor: () => tls.clientFingerprint256,
      snapshot: () => snapshot,
      keyRing: ring.ring,
      journal,
      allowedOrigin: JM_ORIGIN,
      now: () => new Date(),
    });

    // Given the established journal is lost after the store was built.
    rmSync(path);
    const reserved = await store.authorizeAndReserve({ envelope, certificate: undefined });

    // Then the dispatch is refused, so no executor can run, and nothing reappears.
    expect(reserved.kind, 'reserveAfterLoss').toBe('unavailable');
    expect(existsSync(path), 'fileRecreated').toBe(false);
    expect(journal.healthy()).toBe(false);
  });
});
