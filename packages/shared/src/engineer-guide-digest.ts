/**
 * Integrity digest for an engineer guide (E08).
 *
 * This hashes the supplied guide fields only. It does not assemble a case,
 * assess requirements, or change readiness. A matching digest is not
 * review_ready, field_accepted, or approved_for_window.
 */
import { createHash } from 'node:crypto';
import type { EngineerGuide } from './engineer-case-contract.js';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  throw new Error('GUIDE_CANONICAL_NON_JSON');
}

export function computeEngineerGuideDigest(guide: Omit<EngineerGuide, 'digest'>): string {
  return createHash('sha256').update(canonicalJson(guide)).digest('hex');
}
