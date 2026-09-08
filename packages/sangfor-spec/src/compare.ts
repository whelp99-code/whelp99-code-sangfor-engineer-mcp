/** Three-state comparison of an observed value against a spec expectation. */

import type { CompareOp } from './types.js';

export type CompareOutcome = 'pass' | 'fail' | 'indeterminate';

const isScalar = (v: unknown): boolean =>
  v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);

/** Parse a value to a finite number, or null if it cannot be trusted as numeric.
 *  Only plain decimal strings are accepted — hex/binary/octal/exponent syntax
 *  (0x10, 0b1111, 1e3) would let Number() invent a value, so they are rejected. */
const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!DECIMAL_RE.test(t)) return null; // rejects '', '0x10', '0b1', '1e3', 'N/A'
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null; // boolean / object / null / undefined are not trustworthy numbers
}

/**
 * Compare an observed value to the spec's expected value. Returns a THREE-state
 * outcome: a type/shape mismatch yields 'indeterminate' rather than silently
 * coercing into a fabricated 'pass'/'fail' (INDETERMINATE ≠ PASS principle).
 */
export function compareValue(op: CompareOp, observed: unknown, expected: unknown): CompareOutcome {
  switch (op) {
    case 'eq':
    case 'neq': {
      // NaN is unknown, not a comparable value — never let NaN produce a pass/fail.
      const isNaNv = (x: unknown) => typeof x === 'number' && Number.isNaN(x);
      if (isNaNv(observed) || isNaNv(expected)) return 'indeterminate';
      // If both are scalars of different primitive type (e.g. boolean true vs
      // scraped string 'true'), the comparison is untrustworthy → indeterminate.
      if (isScalar(observed) && isScalar(expected) && observed != null && expected != null
        && typeof observed !== typeof expected) {
        return 'indeterminate';
      }
      const equal = observed === expected;
      return (op === 'eq' ? equal : !equal) ? 'pass' : 'fail';
    }
    case 'gte':
    case 'lte': {
      const a = toFiniteNumber(observed);
      const b = toFiniteNumber(expected);
      if (a === null || b === null) return 'indeterminate';
      return (op === 'gte' ? a >= b : a <= b) ? 'pass' : 'fail';
    }
    case 'includes': {
      // An empty/absent expected would make every string "contain" it — vacuous PASS.
      if (expected === '' || expected == null) return 'indeterminate';
      if (Array.isArray(observed)) return observed.includes(expected) ? 'pass' : 'fail';
      if (typeof observed === 'string' && (typeof expected === 'string' || typeof expected === 'number')) {
        return observed.includes(String(expected)) ? 'pass' : 'fail';
      }
      return 'indeterminate';
    }
    case 'oneOf':
      if (!Array.isArray(expected)) return 'indeterminate';
      return expected.includes(observed) ? 'pass' : 'fail';
    case 'exists':
      return observed !== undefined && observed !== null && observed !== '' ? 'pass' : 'fail';
    default:
      return 'indeterminate';
  }
}
