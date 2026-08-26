import { createHash } from 'node:crypto';

class IagCanonicalizationError extends Error {
  readonly name = 'IagCanonicalizationError';
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new IagCanonicalizationError('Non-finite value refused');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new IagCanonicalizationError('Non-JSON value refused');
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

export function digestCanonicalIagValue(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\0${canonical(value)}`, 'utf8').digest('hex');
}

export function canonicalIagValuesEqual(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}
