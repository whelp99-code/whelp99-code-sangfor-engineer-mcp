import { describe, expect, it } from 'vitest';
import { compareVersions, checkVersionRequirement } from '../packages/sangfor-version/src/index.js';

describe('compareVersions (semver-lite, handles R suffixes)', () => {
  it('orders versions numerically', () => {
    expect(compareVersions('3.0.92', '3.0.98')).toBe(-1);
    expect(compareVersions('3.0.98', '3.0.92')).toBe(1);
    expect(compareVersions('6.11.3', '6.11.3')).toBe(0);
    expect(compareVersions('6.9.0', '6.10.0')).toBe(-1); // not lexicographic
    expect(compareVersions('13.0.80', '13.0.120')).toBe(-1);
  });
  it('treats an R/build suffix as a lower-order segment', () => {
    expect(compareVersions('6.0.4R4', '6.0.4')).toBe(1); // R4 build > base (no R)
    expect(compareVersions('6.10.0R2', '6.10.0R1')).toBe(1);
    expect(compareVersions('6.0.4R1', '6.0.4R1')).toBe(0);
  });
});

describe('checkVersionRequirement (grounded in collected Version Requirements)', () => {
  it('flags a device below the minimum supported version', () => {
    const r = checkVersionRequirement('Athena NDR', '3.0.90');
    expect(r).not.toBeNull();
    expect(r!.meetsMin).toBe(false);
    expect(r!.source).toBeTruthy();
  });
  it('recognizes a version that meets min but is below recommended', () => {
    const r = checkVersionRequirement('Athena NDR', '3.0.95');
    expect(r!.meetsMin).toBe(true);
    expect(r!.atRecommended).toBe(false);
  });
  it('recognizes a version at/above recommended', () => {
    const r = checkVersionRequirement('Athena NDR', '3.0.98');
    expect(r!.meetsMin).toBe(true);
    expect(r!.atRecommended).toBe(true);
  });
  it('returns null (no fabrication) for an unknown device', () => {
    expect(checkVersionRequirement('Some Unknown Box', '1.0.0')).toBeNull();
  });
});
