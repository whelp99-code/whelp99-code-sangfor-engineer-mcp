/**
 * E05 formula catalog and unit policy. These are the only official arithmetic
 * formulas in this package. Advisory sizing tiers are not formulas.
 *
 * Byte families are not interchangeable: GB = 1000^3 bytes, GiB = 1024^3 bytes.
 */
import type { EngineerUnit } from '../../shared/src/engineer-case-contract.js';

export const ENGINEER_FORMULA_IDS = [
  'confirmed-remaining-capacity',
  'confirmed-utilization-ratio',
  'demand-headroom',
] as const;

export type EngineerFormulaId = (typeof ENGINEER_FORMULA_IDS)[number];
export type EngineerFormulaRole = 'total' | 'used' | 'demand';

export const ENGINEER_FORMULA_CATALOG = {
  'confirmed-remaining-capacity': {
    version: '1.0.0',
    roles: ['total', 'used'] as const,
    resultKind: 'capacity' as const,
    decimalScale: 9,
    description: 'remaining = total - used after documented unit conversion',
    zeroDenominator: 'not used; total 0 and used 0 is a derived zero remaining',
    rounding: 'half-away-from-zero to 9 decimals after conversion; identity when units already match',
    negativeInputs: 'any negative total/used is NEGATIVE_INPUT (unavailable)',
    exceeded: 'used > total yields a derived negative remaining, not unknown',
    stalePartial: 'partial/failed/missing/unsupported/unknown collection or expired freshness is unavailable',
    units: 'SI KB/MB/GB/TB = 1000^n; IEC KiB/MiB/GiB/TiB = 1024^n; mixed families convert via bytes; other dimensions must match exactly',
  },
  'confirmed-utilization-ratio': {
    version: '1.0.0',
    roles: ['total', 'used'] as const,
    resultKind: 'percent' as const,
    decimalScale: 6,
    description: 'utilization percent = used / total * 100 after unit conversion',
    zeroDenominator: 'total 0 is DIVISION_BY_ZERO (unavailable); used 0 with total > 0 is a derived zero',
    rounding: 'half-away-from-zero to 6 decimals',
    negativeInputs: 'any negative total/used is NEGATIVE_INPUT (unavailable)',
    exceeded: 'used > total yields a derived percent above 100, not unknown',
    stalePartial: 'partial/failed/missing/unsupported/unknown collection or expired freshness is unavailable',
    units: 'same SI/IEC conversion as remaining (GB ≠ GiB); result unit is always percent',
  },
  'demand-headroom': {
    version: '1.0.0',
    roles: ['total', 'used', 'demand'] as const,
    resultKind: 'capacity' as const,
    decimalScale: 9,
    description: 'headroom = (total - used) - demand after documented unit conversion',
    zeroDenominator: 'not used; all-zero inputs yield a derived zero headroom',
    rounding: 'half-away-from-zero to 9 decimals after conversion; identity when units already match',
    negativeInputs: 'any negative total/used/demand is NEGATIVE_INPUT (unavailable)',
    exceeded: 'demand above remaining yields a derived negative headroom, not unknown',
    stalePartial: 'partial/failed/missing/unsupported/unknown collection or expired freshness is unavailable',
    units: 'same SI/IEC conversion as remaining (GB ≠ GiB); demand must share the capacity dimension of total; a percent demand is UNIT_INCOMPATIBLE',
  },
} as const;

export function isEngineerFormulaId(value: string): value is EngineerFormulaId {
  return (ENGINEER_FORMULA_IDS as readonly string[]).includes(value);
}

export function roundHalfAway(value: number, scale: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(scale) || scale < 0) return Number.NaN;
  const factor = 10 ** scale;
  const scaled = value * factor;
  const sign = scaled < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(scaled))) / factor;
}

const IEC_EXP: Partial<Record<EngineerUnit, number>> = {
  B: 0, KiB: 1, MiB: 2, GiB: 3, TiB: 4,
};
const SI_EXP: Partial<Record<EngineerUnit, number>> = {
  B: 0, KB: 1, MB: 2, GB: 3, TB: 4,
};

export type UnitConversion =
  | { readonly ok: true; readonly value: number; readonly converted: boolean }
  | { readonly ok: false; readonly reason: string };

function scaleByBase(value: number, base: number, exp: number): UnitConversion {
  if (exp === 0) return finiteOrOverflow(value, false);
  let result = value;
  if (exp > 0) {
    for (let i = 0; i < exp; i += 1) {
      result *= base;
      const checked = finiteOrOverflow(result, true);
      if (!checked.ok) return checked;
    }
    return { ok: true, value: result, converted: true };
  }
  for (let i = 0; i < -exp; i += 1) {
    result /= base;
    if (!Number.isFinite(result)) return { ok: false, reason: 'INVALID_NUMBER' };
  }
  return { ok: true, value: result, converted: true };
}

function finiteOrOverflow(value: number, converted: boolean): UnitConversion {
  if (!Number.isFinite(value)) return { ok: false, reason: 'INVALID_NUMBER' };
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) return { ok: false, reason: 'OVERFLOW' };
  return { ok: true, value, converted };
}

function samePercent(from: EngineerUnit, to: EngineerUnit): boolean {
  return (from === 'percent' || from === '%') && (to === 'percent' || to === '%');
}

/**
 * Convert a finite quantity from one declared unit to another.
 * Unknown or incompatible dimensions stay unavailable — they are never treated as 1.
 */
export function convertEngineerUnit(value: number, from: EngineerUnit, to: EngineerUnit): UnitConversion {
  if (!Number.isFinite(value)) return { ok: false, reason: 'INVALID_NUMBER' };
  if (from === to || samePercent(from, to)) return { ok: true, value, converted: from !== to };
  const iecFrom = IEC_EXP[from];
  const iecTo = IEC_EXP[to];
  const siFrom = SI_EXP[from];
  const siTo = SI_EXP[to];
  const fromIec = from !== 'B' && iecFrom !== undefined;
  const toIec = to !== 'B' && iecTo !== undefined;
  const fromSi = from !== 'B' && siFrom !== undefined;
  const toSi = to !== 'B' && siTo !== undefined;
  const fromByte = from === 'B';
  const toByte = to === 'B';

  if ((fromIec || fromByte) && (toIec || toByte) && !fromSi && !toSi) {
    return scaleByBase(value, 1024, (iecFrom ?? 0) - (iecTo ?? 0));
  }
  if ((fromSi || fromByte) && (toSi || toByte) && !fromIec && !toIec) {
    return scaleByBase(value, 1000, (siFrom ?? 0) - (siTo ?? 0));
  }
  if ((fromIec || fromSi || fromByte) && (toIec || toSi || toByte)) {
    const toBytes = fromIec ? scaleByBase(value, 1024, iecFrom ?? 0)
      : fromSi ? scaleByBase(value, 1000, siFrom ?? 0)
        : { ok: true as const, value, converted: false };
    if (!toBytes.ok) return toBytes;
    const fromBytes = toIec ? scaleByBase(toBytes.value, 1024, -(iecTo ?? 0))
      : toSi ? scaleByBase(toBytes.value, 1000, -(siTo ?? 0))
        : toBytes;
    if (!fromBytes.ok) return fromBytes;
    return { ok: true, value: fromBytes.value, converted: true };
  }
  return { ok: false, reason: 'UNIT_INCOMPATIBLE' };
}
