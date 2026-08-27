import { KeyObject, createPrivateKey, sign } from 'node:crypto';

/**
 * BLRO-side minting of the artifacts JM only ever verifies.
 *
 * This lives in the authority package on purpose: BLRO is canonical, so the
 * private-key signer must sit behind the authority boundary. The JM package
 * and the JM app cannot import this module, and an export-boundary test proves
 * that they do not.
 */

export type SignableAuthorityArtifact = Readonly<Record<string, unknown>>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

function ed25519PrivateKey(key: KeyObject | string): KeyObject {
  const object = key instanceof KeyObject ? key : createPrivateKey(key);
  if (object.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('An Ed25519 private key is required to sign JM authority artifacts.');
  }
  return object;
}

/**
 * Produces the detached `<payload>.<signature>` form JM verifies, over the
 * canonical bytes of the artifact.
 */
export function signJmAuthorityArtifact(
  artifact: SignableAuthorityArtifact,
  privateKey: KeyObject | string,
): string {
  const payload = Buffer.from(canonical(artifact), 'utf8').toString('base64url');
  const signature = sign(
    null,
    Buffer.from(payload, 'utf8'),
    ed25519PrivateKey(privateKey),
  ).toString('base64url');
  return `${payload}.${signature}`;
}
