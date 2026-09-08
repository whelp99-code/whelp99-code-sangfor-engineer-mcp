import { z } from 'zod';
import { deriveReservationDigest } from '@sangfor/browser-contracts';
import { canonicalPayload, ed25519PublicKey, verifyDetached } from './signing.js';

export const AUTHORITY_RECEIPT_VERSION = 'blro-authority-receipt.v1' as const;

const idSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+=/-]*$/u)
  .refine((value) => !value.includes('..'));
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true });

/**
 * A per-dispatch authorization minted by BLRO for exactly one job request.
 *
 * Every field below is a binding JM verifies exactly before the executor runs.
 * Because the receipt names the jobId, requestId, JTI, request digest,
 * capability digest, verify-key identity, mTLS client fingerprint and the
 * BLRO-side tombstone/reservation digest, a receipt cannot be replayed onto a
 * different job, request, capability, key, peer, or reservation.
 */
export const authorityReceiptSchema = z.object({
  version: z.literal(AUTHORITY_RECEIPT_VERSION),
  receiptId: idSchema,
  tenantId: idSchema,
  projectId: idSchema,
  installationId: idSchema,
  deviceBindingDigest: digestSchema,
  origin: z.string().url(),
  authorityEpoch: z.number().int().nonnegative(),
  jobId: idSchema,
  requestId: idSchema,
  capabilityJti: idSchema,
  requestDigest: digestSchema,
  capabilityDigest: digestSchema,
  capabilityVerifyKeyId: idSchema,
  capabilityVerifyKeyDigest: digestSchema,
  clientCertificateFingerprintSha256: digestSchema,
  reservationDigest: digestSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict().readonly();

export type AuthorityReceipt = z.infer<typeof authorityReceiptSchema>;

export const AUTHORITY_RECEIPT_REFUSALS = {
  FORMAT_INVALID: 'RECEIPT_FORMAT_INVALID',
  SIGNATURE_INVALID: 'RECEIPT_SIGNATURE_INVALID',
  VERIFY_KEY_INVALID: 'RECEIPT_VERIFY_KEY_INVALID',
  EXPIRED: 'RECEIPT_EXPIRED',
  NOT_YET_VALID: 'RECEIPT_NOT_YET_VALID',
  SCOPE_MISMATCH: 'RECEIPT_SCOPE_MISMATCH',
  ORIGIN_MISMATCH: 'RECEIPT_ORIGIN_MISMATCH',
  EPOCH_MISMATCH: 'RECEIPT_EPOCH_MISMATCH',
  JOB_MISMATCH: 'RECEIPT_JOB_MISMATCH',
  REQUEST_MISMATCH: 'RECEIPT_REQUEST_MISMATCH',
  CAPABILITY_MISMATCH: 'RECEIPT_CAPABILITY_MISMATCH',
  VERIFY_KEY_ID_MISMATCH: 'RECEIPT_VERIFY_KEY_ID_MISMATCH',
  CLIENT_FINGERPRINT_MISMATCH: 'RECEIPT_CLIENT_FINGERPRINT_MISMATCH',
  DEVICE_MISMATCH: 'RECEIPT_DEVICE_MISMATCH',
  RECEIPT_ID_MISMATCH: 'RECEIPT_ID_MISMATCH',
  RESERVATION_MISMATCH: 'RECEIPT_RESERVATION_MISMATCH',
  VERSION_MISMATCH: 'RECEIPT_VERSION_MISMATCH',
} as const;

export type AuthorityReceiptRefusal =
  (typeof AUTHORITY_RECEIPT_REFUSALS)[keyof typeof AUTHORITY_RECEIPT_REFUSALS];

export type AuthorityReceiptDecision =
  | { readonly ok: true; readonly receipt: AuthorityReceipt }
  | { readonly ok: false; readonly reason: AuthorityReceiptRefusal };

/**
 * Everything the dispatch must match, derived from the actual request.
 *
 * `receiptId` is supplied by the caller (BLRO announces it out of band, e.g. the
 * transport header) and `reservationDigest` is DERIVED here via the shared
 * deriveReservationDigest. Neither is ever read out of the receipt being
 * checked — a self-copied field proves nothing.
 */
export type AuthorityReceiptExpectation = {
  readonly receiptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly deviceBindingDigest: string;
  readonly authorityEpoch: number;
  readonly origin: string;
  readonly jobId: string;
  readonly requestId: string;
  readonly capabilityJti: string;
  readonly requestDigest: string;
  readonly capabilityDigest: string;
  readonly capabilityVerifyKeyId: string;
  readonly capabilityVerifyKeyDigest: string;
  readonly clientCertificateFingerprintSha256: string;
};

export type VerifyAuthorityReceiptInput = {
  readonly receipt: string;
  readonly publicKeyPem: string;
  readonly expected: AuthorityReceiptExpectation;
  readonly now: Date;
};

export function verifyAuthorityReceipt(
  input: VerifyAuthorityReceiptInput,
): AuthorityReceiptDecision {
  const key = ed25519PublicKey(input.publicKeyPem);
  if (!key) return refuse(AUTHORITY_RECEIPT_REFUSALS.VERIFY_KEY_INVALID);
  const parts = input.receipt.trim().split('.');
  const payload = parts[0];
  const signature = parts[1];
  if (parts.length !== 2 || !payload || !signature) {
    return refuse(AUTHORITY_RECEIPT_REFUSALS.FORMAT_INVALID);
  }
  if (!verifyDetached(payload, signature, key)) {
    return refuse(AUTHORITY_RECEIPT_REFUSALS.SIGNATURE_INVALID);
  }
  const receipt = canonicalPayload(payload, authorityReceiptSchema);
  if (!receipt) return refuse(AUTHORITY_RECEIPT_REFUSALS.FORMAT_INVALID);
  const binding = checkBindings(receipt, input.expected);
  if (binding) return refuse(binding);
  const now = input.now.getTime();
  if (Date.parse(receipt.issuedAt) > now) return refuse(AUTHORITY_RECEIPT_REFUSALS.NOT_YET_VALID);
  if (Date.parse(receipt.expiresAt) <= now) return refuse(AUTHORITY_RECEIPT_REFUSALS.EXPIRED);
  return { ok: true, receipt };
}

function checkBindings(
  receipt: AuthorityReceipt,
  expected: AuthorityReceiptExpectation,
): AuthorityReceiptRefusal | undefined {
  const R = AUTHORITY_RECEIPT_REFUSALS;
  if (receipt.tenantId !== expected.tenantId
    || receipt.projectId !== expected.projectId
    || receipt.installationId !== expected.installationId) return R.SCOPE_MISMATCH;
  if (receipt.deviceBindingDigest !== expected.deviceBindingDigest) return R.DEVICE_MISMATCH;
  if (receipt.origin !== expected.origin) return R.ORIGIN_MISMATCH;
  if (receipt.authorityEpoch !== expected.authorityEpoch) return R.EPOCH_MISMATCH;
  if (receipt.jobId !== expected.jobId) return R.JOB_MISMATCH;
  if (receipt.requestId !== expected.requestId
    || receipt.requestDigest !== expected.requestDigest) return R.REQUEST_MISMATCH;
  if (receipt.capabilityJti !== expected.capabilityJti
    || receipt.capabilityDigest !== expected.capabilityDigest) return R.CAPABILITY_MISMATCH;
  if (receipt.capabilityVerifyKeyId !== expected.capabilityVerifyKeyId
    || receipt.capabilityVerifyKeyDigest !== expected.capabilityVerifyKeyDigest) {
    return R.VERIFY_KEY_ID_MISMATCH;
  }
  if (receipt.clientCertificateFingerprintSha256
    !== expected.clientCertificateFingerprintSha256) return R.CLIENT_FINGERPRINT_MISMATCH;
  if (receipt.receiptId !== expected.receiptId) return R.RECEIPT_ID_MISMATCH;
  // Derived independently from the request scope, never copied from the receipt.
  if (receipt.reservationDigest !== deriveReservationDigest({
    tenantId: expected.tenantId,
    projectId: expected.projectId,
    installationId: expected.installationId,
    deviceBindingDigest: expected.deviceBindingDigest,
    authorityEpoch: expected.authorityEpoch,
    jobId: expected.jobId,
    requestId: expected.requestId,
    capabilityJti: expected.capabilityJti,
    requestDigest: expected.requestDigest,
    capabilityDigest: expected.capabilityDigest,
  })) return R.RESERVATION_MISMATCH;
  return undefined;
}

function refuse(reason: AuthorityReceiptRefusal): AuthorityReceiptDecision {
  return { ok: false, reason };
}
