import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_RING_VERSION } from '../../packages/sangfor-jm-agent/src/index.js';

export const CURRENT_KEY_ID = 'blro-key-current';
export const OVERLAP_KEY_ID = 'blro-key-overlap';

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

export function readKeyRing(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
