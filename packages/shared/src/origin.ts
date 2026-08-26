import { createHash } from 'node:crypto';

export type CanonicalOriginInput = 'url' | 'origin';

export class CanonicalOriginError extends Error {
  readonly name = 'CanonicalOriginError';

  constructor(readonly code: 'invalid_url' | 'invalid_scheme' | 'credentials_refused' | 'origin_only_required') {
    super(`CANONICAL_ORIGIN_REFUSED: ${code}`);
  }
}

const ORIGIN_ONLY_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+$/u;
const ORIGIN_DIGEST_DOMAIN = 'sangfor.origin.v1';

export function canonicalizeUrlOrigin(value: string, input: CanonicalOriginInput): string {
  if (input === 'origin' && !ORIGIN_ONLY_PATTERN.test(value)) throw new CanonicalOriginError('origin_only_required');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CanonicalOriginError('invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CanonicalOriginError('invalid_scheme');
  if (url.username.length > 0 || url.password.length > 0) throw new CanonicalOriginError('credentials_refused');
  return url.origin;
}

export function digestCanonicalOrigin(value: string, input: CanonicalOriginInput): string {
  const origin = canonicalizeUrlOrigin(value, input);
  return createHash('sha256').update(`${ORIGIN_DIGEST_DOMAIN}\0${origin}`, 'utf8').digest('hex');
}
