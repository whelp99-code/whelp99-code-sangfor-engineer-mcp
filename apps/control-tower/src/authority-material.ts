import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

const MAX_KEY_FILE_BYTES = 65_536;

export type AuthorityMaterial = {
  readonly signingPrivateKey: KeyObject;
  readonly trustBundle: Buffer;
};

export type AuthorityMaterialResult =
  | { readonly ok: true; readonly material: AuthorityMaterial }
  | {
    readonly ok: false;
    readonly signing: boolean;
    readonly trust: boolean;
  };

async function boundedFile(path: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_KEY_FILE_BYTES) {
    throw new TypeError('Authority material must be a non-empty bounded regular file.');
  }
  return readFile(path);
}

export async function loadAuthorityMaterial(
  signingPrivateKeyPath: string,
  trustBundlePath: string,
): Promise<AuthorityMaterialResult> {
  let signingPrivateKey: KeyObject | undefined;
  let trustBundle: Buffer | undefined;
  try {
    const encoded = await boundedFile(signingPrivateKeyPath);
    const key = createPrivateKey(encoded);
    if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Signing key must be Ed25519.');
    signingPrivateKey = key;
  } catch {
    signingPrivateKey = undefined;
  }
  try {
    const encoded = await boundedFile(trustBundlePath);
    const text = encoded.toString('utf8');
    const certificates = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu) ?? [];
    if (certificates.length === 0 || text.replaceAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu, '').trim()) {
      throw new TypeError('Trust bundle must contain only PEM certificates.');
    }
    for (const certificate of certificates) {
      if (!new X509Certificate(certificate).ca) throw new TypeError('Trust anchor must be a CA certificate.');
    }
    trustBundle = encoded;
  } catch {
    trustBundle = undefined;
  }
  if (!signingPrivateKey || !trustBundle) {
    return { ok: false, signing: signingPrivateKey !== undefined, trust: trustBundle !== undefined };
  }
  return { ok: true, material: { signingPrivateKey, trustBundle } };
}
