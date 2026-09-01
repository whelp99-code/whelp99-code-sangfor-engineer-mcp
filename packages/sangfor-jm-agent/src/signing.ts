import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { z } from 'zod';

/**
 * Verification-only cryptography for JM.
 *
 * This module deliberately imports no signer and no private-key API. JM can
 * check that BLRO said something; it can never say something as BLRO. The
 * export-boundary test enforces that this stays true.
 */

export function ed25519PublicKey(pem: string): KeyObject | undefined {
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

export function verifyDetached(payload: string, signature: string, key: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

export function canonicalPayload<TSchema extends z.ZodTypeAny>(
  payload: string,
  schema: TSchema,
): z.infer<TSchema> | undefined {
  try {
    const parsed = schema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
