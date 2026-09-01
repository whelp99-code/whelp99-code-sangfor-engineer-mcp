import { mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  publicKeyDigest,
  verifyAuthorityReceipt,
} from '../packages/sangfor-jm-agent/src/index.js';
import {
  browserExecutionRequestDigest,
  deriveReservationDigest,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  CURRENT_KEY_ID,
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
  JM_ORIGIN,
  JM_PROJECT_ID,
  JM_TENANT_ID,
  browserRequest,
  buildAuthorityReceipt,
  createJmSigningMaterial,
  createJmTlsMaterial,
  mintTaskCapability,
  type JmSigningMaterial,
  type JmTlsMaterial,
} from './helpers/jm-agent-fixture.js';

let root: string;
let tls: JmTlsMaterial;
let signing: JmSigningMaterial;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jm-agent-'));
  tls = createJmTlsMaterial(root);
  signing = createJmSigningMaterial(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('per-dispatch authority receipt binding', () => {
  const verificationTime = new Date('2026-01-01T00:00:00.000Z');

  function bound(overrides: Parameters<typeof buildAuthorityReceipt>[2] = {}) {
    const request = browserRequest();
    const jti = `jti-binding-${randomUUID()}`;
    const capability = mintTaskCapability(signing, request, { jti });
    const receipt = buildAuthorityReceipt(signing, {
      request, jobId: request.requestId, capability, capabilityJti: jti,
      clientFingerprint: tls.clientFingerprint256,
    }, { issuedAt: verificationTime.toISOString(), ...overrides });
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
      now: verificationTime,
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
      {
        field: 'expiresAt',
        patch: { expiresAt: new Date(verificationTime.getTime() - 60_000).toISOString() },
      },
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
        now: verificationTime,
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
      now: verificationTime,
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
      now: verificationTime,
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
      now: verificationTime,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe('RECEIPT_ID_MISMATCH');
  });
});
