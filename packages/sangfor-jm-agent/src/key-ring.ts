import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ed25519PublicKey } from './signing.js';

export const KEY_RING_VERSION = 'jm-verify-key-ring.v1' as const;

/** At most one overlap key may coexist with the current key. */
export const MAX_OVERLAP_KEYS = 1;

const keyEntrySchema = z.object({
  keyId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  role: z.enum(['current', 'overlap']),
  publicKeyPem: z.string().min(1).max(8192),
  notBefore: z.string().datetime({ offset: true }),
  notAfter: z.string().datetime({ offset: true }),
}).strict().readonly();

export const keyRingSchema = z.object({
  version: z.literal(KEY_RING_VERSION),
  maxOverlapMs: z.number().int().positive().max(86_400_000),
  keys: z.array(keyEntrySchema).min(1).max(1 + MAX_OVERLAP_KEYS).readonly(),
}).strict().readonly();

export type KeyRingEntry = z.infer<typeof keyEntrySchema>;
export type KeyRingDocument = z.infer<typeof keyRingSchema>;

export const KEY_RING_REFUSALS = {
  FORMAT_INVALID: 'KEY_RING_FORMAT_INVALID',
  KEY_INVALID: 'KEY_RING_KEY_INVALID',
  DUPLICATE_KEY_ID: 'KEY_RING_DUPLICATE_KEY_ID',
  CURRENT_MISSING: 'KEY_RING_CURRENT_MISSING',
  TOO_MANY_OVERLAPS: 'KEY_RING_TOO_MANY_OVERLAPS',
  OVERLAP_TOO_LONG: 'KEY_RING_OVERLAP_TOO_LONG',
  WINDOW_INVALID: 'KEY_RING_WINDOW_INVALID',
  KEY_UNKNOWN: 'KEY_RING_KEY_UNKNOWN',
  KEY_STALE: 'KEY_RING_KEY_STALE',
  KEY_FUTURE: 'KEY_RING_KEY_FUTURE',
} as const;

export type KeyRingRefusal = (typeof KEY_RING_REFUSALS)[keyof typeof KEY_RING_REFUSALS];

export type KeyRingResolution =
  | { readonly ok: true; readonly entry: KeyRingEntry; readonly digest: string }
  | { readonly ok: false; readonly reason: KeyRingRefusal };

export type KeyRingLoad =
  | { readonly ok: true; readonly ring: KeyRing }
  | { readonly ok: false; readonly reason: KeyRingRefusal };

export function publicKeyDigest(pem: string): string {
  return createHash('sha256').update(pem.trim(), 'utf8').digest('hex');
}

/**
 * A bounded rotation ring: exactly one current key plus at most one overlap
 * key, each with an explicit id and validity window, and a hard cap on how
 * long an overlap may last. Unknown, stale, future or extra keys are refused.
 */
export class KeyRing {
  private constructor(private readonly document: KeyRingDocument) {}

  static load(raw: unknown): KeyRingLoad {
    const parsed = keyRingSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: KEY_RING_REFUSALS.FORMAT_INVALID };
    const document = parsed.data;
    const ids = new Set(document.keys.map((entry) => entry.keyId));
    if (ids.size !== document.keys.length) {
      return { ok: false, reason: KEY_RING_REFUSALS.DUPLICATE_KEY_ID };
    }
    const current = document.keys.filter((entry) => entry.role === 'current');
    if (current.length !== 1) return { ok: false, reason: KEY_RING_REFUSALS.CURRENT_MISSING };
    if (document.keys.length - current.length > MAX_OVERLAP_KEYS) {
      return { ok: false, reason: KEY_RING_REFUSALS.TOO_MANY_OVERLAPS };
    }
    for (const entry of document.keys) {
      if (!ed25519PublicKey(entry.publicKeyPem)) {
        return { ok: false, reason: KEY_RING_REFUSALS.KEY_INVALID };
      }
      const from = Date.parse(entry.notBefore);
      const to = Date.parse(entry.notAfter);
      if (!(to > from)) return { ok: false, reason: KEY_RING_REFUSALS.WINDOW_INVALID };
      if (entry.role === 'overlap' && to - from > document.maxOverlapMs) {
        return { ok: false, reason: KEY_RING_REFUSALS.OVERLAP_TOO_LONG };
      }
    }
    return { ok: true, ring: new KeyRing(document) };
  }

  /** Resolves the exact key a receipt names, refusing outside its window. */
  resolve(keyId: string, now: Date): KeyRingResolution {
    const entry = this.document.keys.find((candidate) => candidate.keyId === keyId);
    if (!entry) return { ok: false, reason: KEY_RING_REFUSALS.KEY_UNKNOWN };
    const moment = now.getTime();
    if (moment < Date.parse(entry.notBefore)) {
      return { ok: false, reason: KEY_RING_REFUSALS.KEY_FUTURE };
    }
    if (moment >= Date.parse(entry.notAfter)) {
      return { ok: false, reason: KEY_RING_REFUSALS.KEY_STALE };
    }
    return { ok: true, entry, digest: publicKeyDigest(entry.publicKeyPem) };
  }

  /** True when at least one key is usable now; drives the readiness check. */
  hasUsableKey(now: Date): boolean {
    return this.document.keys.some((entry) => this.resolve(entry.keyId, now).ok);
  }
}
