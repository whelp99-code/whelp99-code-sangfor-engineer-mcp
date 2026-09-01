import { z } from 'zod';
import { ed25519PublicKey, canonicalPayload, verifyDetached } from './signing.js';

export const GRANT_SNAPSHOT_VERSION = 'blro-enrollment-grant-snapshot.v1' as const;

const idSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+=/-]*$/u)
  .refine((value) => !value.includes('..'));
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true });

/**
 * The startup enrollment/grant snapshot. It establishes the durable identity a
 * JM installation is bound to and the epoch its refusal journal is genesis-bound
 * to. It authorizes no individual job: that is the per-dispatch receipt's role.
 */
export const grantSnapshotSchema = z.object({
  version: z.literal(GRANT_SNAPSHOT_VERSION),
  snapshotId: idSchema,
  tenantId: idSchema,
  projectId: idSchema,
  installationId: idSchema,
  clientIdentityId: idSchema,
  deviceBindingDigest: digestSchema,
  authorityEpoch: z.number().int().nonnegative(),
  state: z.enum(['active', 'revoked']),
  grants: z.array(z.object({
    originDigest: digestSchema,
    scope: idSchema,
  }).strict().readonly()).min(1).max(256).readonly(),
  journalGenesis: digestSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict().readonly();

export type GrantSnapshot = z.infer<typeof grantSnapshotSchema>;

export const GRANT_SNAPSHOT_REFUSALS = {
  FORMAT_INVALID: 'SNAPSHOT_FORMAT_INVALID',
  SIGNATURE_INVALID: 'SNAPSHOT_SIGNATURE_INVALID',
  VERIFY_KEY_INVALID: 'SNAPSHOT_VERIFY_KEY_INVALID',
  EXPIRED: 'SNAPSHOT_EXPIRED',
  NOT_YET_VALID: 'SNAPSHOT_NOT_YET_VALID',
  SCOPE_MISMATCH: 'SNAPSHOT_SCOPE_MISMATCH',
  REVOKED: 'SNAPSHOT_ENROLLMENT_REVOKED',
} as const;

export type GrantSnapshotRefusal =
  (typeof GRANT_SNAPSHOT_REFUSALS)[keyof typeof GRANT_SNAPSHOT_REFUSALS];

export type GrantSnapshotDecision =
  | { readonly ok: true; readonly snapshot: GrantSnapshot }
  | { readonly ok: false; readonly reason: GrantSnapshotRefusal };

export type GrantSnapshotScope = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly installationId: string;
};

export type VerifyGrantSnapshotInput = {
  readonly snapshot: string;
  readonly publicKeyPem: string;
  readonly expected: GrantSnapshotScope;
  readonly now: Date;
};

/**
 * Signature and identity binding are checked here; freshness/revocation are
 * reported separately so a correctly signed but stale or revoked snapshot can
 * keep the process alive and merely unready, per the lifecycle contract.
 */
export function verifyGrantSnapshot(input: VerifyGrantSnapshotInput): GrantSnapshotDecision {
  const key = ed25519PublicKey(input.publicKeyPem);
  if (!key) return { ok: false, reason: GRANT_SNAPSHOT_REFUSALS.VERIFY_KEY_INVALID };
  const parts = input.snapshot.trim().split('.');
  const payload = parts[0];
  const signature = parts[1];
  if (parts.length !== 2 || !payload || !signature) {
    return { ok: false, reason: GRANT_SNAPSHOT_REFUSALS.FORMAT_INVALID };
  }
  if (!verifyDetached(payload, signature, key)) {
    return { ok: false, reason: GRANT_SNAPSHOT_REFUSALS.SIGNATURE_INVALID };
  }
  const decoded = decode(payload);
  if (!decoded) return { ok: false, reason: GRANT_SNAPSHOT_REFUSALS.FORMAT_INVALID };
  if (decoded.tenantId !== input.expected.tenantId
    || decoded.projectId !== input.expected.projectId
    || decoded.installationId !== input.expected.installationId) {
    return { ok: false, reason: GRANT_SNAPSHOT_REFUSALS.SCOPE_MISMATCH };
  }
  const now = input.now.getTime();
  if (Date.parse(decoded.issuedAt) > now) {
    return { ok: false, reason: GRANT_SNAPSHOT_REFUSALS.NOT_YET_VALID };
  }
  if (Date.parse(decoded.expiresAt) <= now) {
    return { ok: false, reason: GRANT_SNAPSHOT_REFUSALS.EXPIRED };
  }
  if (decoded.state === 'revoked') {
    return { ok: false, reason: GRANT_SNAPSHOT_REFUSALS.REVOKED };
  }
  return { ok: true, snapshot: decoded };
}

/** Signature-and-identity only: used to decide "start" versus "serve". */
export function grantSnapshotIsStructurallyTrusted(
  input: VerifyGrantSnapshotInput,
): boolean {
  const decision = verifyGrantSnapshot(input);
  if (decision.ok) return true;
  return decision.reason === GRANT_SNAPSHOT_REFUSALS.EXPIRED
    || decision.reason === GRANT_SNAPSHOT_REFUSALS.REVOKED;
}

export function decodeGrantSnapshotUnverified(snapshot: string): GrantSnapshot | undefined {
  const payload = snapshot.trim().split('.')[0];
  return payload ? decode(payload) : undefined;
}

function decode(payload: string): GrantSnapshot | undefined {
  const parsed = canonicalPayload(payload, grantSnapshotSchema);
  return parsed;
}
