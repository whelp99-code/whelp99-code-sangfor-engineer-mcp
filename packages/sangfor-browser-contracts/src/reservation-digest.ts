import { createHash } from 'node:crypto';
import { z } from 'zod';

export const RESERVATION_DIGEST_DOMAIN = 'sangfor.blro.reservation.v1' as const;

const idSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+=/-]*$/u)
  .refine((value) => !value.includes('..'));
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * The exact tombstone reservation identity both sides bind to. Every field is
 * part of the at-most-once key, so no two distinct dispatches can share a digest.
 */
export const reservationIdentitySchema = z.object({
  tenantId: idSchema,
  projectId: idSchema,
  installationId: idSchema,
  deviceBindingDigest: digestSchema,
  authorityEpoch: z.number().int().nonnegative(),
  jobId: idSchema,
  requestId: idSchema,
  capabilityJti: idSchema,
  requestDigest: digestSchema,
  capabilityDigest: digestSchema,
}).strict().readonly();

export type ReservationIdentity = z.infer<typeof reservationIdentitySchema>;

/**
 * Pure, canonical, dependency-free derivation of the reservation digest.
 *
 * BLRO's signer and JM's verifier both call THIS function and derive the value
 * independently from the same scope. Neither side ever copies the expected
 * digest out of the receipt it is checking — that would make the field
 * self-certifying and therefore worthless.
 *
 * The encoding is length-prefixed per field so that no combination of field
 * values can be re-partitioned into a different identity with the same bytes.
 */
export function deriveReservationDigest(identity: ReservationIdentity): string {
  const parsed = reservationIdentitySchema.parse(identity);
  const fields: readonly string[] = [
    parsed.tenantId,
    parsed.projectId,
    parsed.installationId,
    parsed.deviceBindingDigest,
    String(parsed.authorityEpoch),
    parsed.jobId,
    parsed.requestId,
    parsed.capabilityJti,
    parsed.requestDigest,
    parsed.capabilityDigest,
  ];
  const encoded = fields
    .map((value) => `${String(Buffer.byteLength(value, 'utf8'))}:${value}`)
    .join('|');
  return createHash('sha256')
    .update(`${RESERVATION_DIGEST_DOMAIN}\u0000${encoded}`, 'utf8')
    .digest('hex');
}
