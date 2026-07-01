/**
 * @sangfor/version — version compatibility + upgrade advisory, grounded in the
 * collected "Version Requirements" tables. Conservative: unknown devices return null
 * (no fabricated compatibility claim).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VersionRequirement {
  device: string;
  minVersion: string;
  recommendedVersion: string;
  source: string;
  sourceUrl?: string;
}

export interface VersionCheck {
  device: string;
  currentVersion: string;
  minVersion: string;
  recommendedVersion: string;
  meetsMin: boolean;
  atRecommended: boolean;
  source: string;
  sourceUrl?: string;
  advice: string;
}

const DATA_ROOT = process.env.SANGFOR_VERSION_ROOT ?? 'data/version';

/** Compare two version strings numerically (segment by segment, digits only). -1|0|1. */
export function compareVersions(a: string, b: string): number {
  // Extract every numeric group (incl. an R-build number) as an ordered segment:
  // '6.0.4R4' → [6,0,4,4], '3.0.92' → [3,0,92], '13.0.120' → [13,0,120].
  const seg = (v: string) => (String(v).match(/\d+/g) ?? []).map(Number);
  const sa = seg(a);
  const sb = seg(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const x = sa[i] ?? 0;
    const y = sb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function loadVersionRequirements(root: string = DATA_ROOT): VersionRequirement[] {
  if (!existsSync(root)) return [];
  const out: VersionRequirement[] = [];
  for (const f of readdirSync(root).filter((x) => x.endsWith('.json') && !x.startsWith('.'))) {
    const parsed = JSON.parse(readFileSync(join(root, f), 'utf8'));
    const arr = Array.isArray(parsed) ? parsed : parsed.requirements;
    if (Array.isArray(arr)) out.push(...(arr as VersionRequirement[]));
  }
  return out;
}

export function checkVersionRequirement(device: string, currentVersion: string, root: string = DATA_ROOT): VersionCheck | null {
  if (typeof device !== 'string' || typeof currentVersion !== 'string') return null;
  const req = loadVersionRequirements(root).find((r) => r.device.trim().toLowerCase() === device.trim().toLowerCase());
  if (!req) return null;
  const meetsMin = compareVersions(currentVersion, req.minVersion) >= 0;
  const atRecommended = compareVersions(currentVersion, req.recommendedVersion) >= 0;
  const advice = !meetsMin
    ? `최소 지원 버전 미만(${currentVersion} < ${req.minVersion}) — 업그레이드 필요(비호환 위험)`
    : atRecommended
      ? `권장 버전 이상(${req.recommendedVersion}) — 양호`
      : `최소는 충족하나 권장 버전(${req.recommendedVersion}) 미만 — 업그레이드 권장`;
  return {
    device: req.device, currentVersion, minVersion: req.minVersion, recommendedVersion: req.recommendedVersion,
    meetsMin, atRecommended, source: req.source, sourceUrl: req.sourceUrl, advice,
  };
}
