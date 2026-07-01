/**
 * @sangfor/sizing — ADVISORY sizing tiering. Deliberately does NOT invent an exact
 * appliance model or node count (that would be fabrication). It maps the primary
 * scale driver to a tier (small/medium/large/xlarge) using EXTERNALIZED, sourced
 * thresholds and always defers the exact BOM to the official Sizing Guide + SE
 * validation. A product with no sourced threshold table returns tier 'unsourced'
 * (판정불가) rather than a fabricated tier from hardcoded numbers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoData } from '../../shared/src/index.js';

export type SizingTier = 'unsourced' | 'insufficient_input' | 'small' | 'medium' | 'large' | 'xlarge';

export interface SizingInput {
  concurrentUsers?: number; // IAG
  endpoints?: number;       // EPP
  vmCount?: number;         // HCI
  eventsPerSecond?: number; // CC
  throughputMbps?: number;  // NGFW
}

export interface SizingDriver { name: string; value: number; }
export interface TierSource { label: string; sourceUrl?: string; }

export interface SizingResult {
  product: string;
  tier: SizingTier;
  drivers: SizingDriver[];
  tierSource: TierSource | null;
  advisory: true;
  disclaimer: string;
  assumptions: string[];
}

interface ThresholdEntry {
  product: string;
  driver: string;
  thresholds: [number, number, number];
  source?: string;
  sourceUrl?: string;
}

const BASE_DISCLAIMER = '자문용 티어 추정입니다. 정확한 모델/노드/라이선스는 공식 Sangfor Sizing Guide와 SE 검증으로 확정하세요. AI는 정확한 BOM을 단정하지 않습니다.';
const DATA_ROOT = resolveRepoData('data/sizing', 'SANGFOR_SIZING_ROOT');

/** Canonical product key + which input field is its scale driver. */
function canonical(product: string): string | null {
  const p = String(product ?? '').trim().toUpperCase();
  if (/IAG|SWG/.test(p)) return 'IAG';
  if (/EPP|ENDPOINT/.test(p)) return 'EPP';
  if (/HCI|SCP/.test(p)) return 'HCI';
  if (/\bCC\b|CYBER|\bNDR\b/.test(p)) return 'CC';
  if (/NGFW|FIREWALL/.test(p)) return 'NGFW';
  return null;
}

const DRIVER_FIELD: Record<string, keyof SizingInput> = {
  IAG: 'concurrentUsers', EPP: 'endpoints', HCI: 'vmCount', CC: 'eventsPerSecond', NGFW: 'throughputMbps',
};

export function loadSizingThresholds(root: string = DATA_ROOT): ThresholdEntry[] {
  const file = join(root, 'thresholds.json');
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const arr = Array.isArray(parsed) ? parsed : parsed.thresholds;
  return Array.isArray(arr) ? (arr as ThresholdEntry[]) : [];
}

function tierByThresholds(value: number, [s, m, l]: [number, number, number]): SizingTier {
  if (value <= s) return 'small';
  if (value <= m) return 'medium';
  if (value <= l) return 'large';
  return 'xlarge';
}

export function recommendSizing(product: string, input: SizingInput, root: string = DATA_ROOT): SizingResult {
  const key = canonical(product);
  const entry = key ? loadSizingThresholds(root).find((e) => e.product.toUpperCase() === key) : undefined;

  // No grounded, sourced threshold table → refuse to fabricate a tier.
  if (!key || !entry || !entry.source) {
    return {
      product: String(product ?? '').trim().toUpperCase(),
      tier: 'unsourced',
      drivers: [],
      tierSource: null,
      advisory: true,
      disclaimer: `임계값 출처 미확정 — 공식 Sizing Guide 미확보로 티어 판정 불가. ${BASE_DISCLAIMER}`,
      assumptions: [`${product}의 사이징 임계값 출처가 확보되지 않아 티어를 산출하지 않음(날조 금지)`],
    };
  }

  const tierSource: TierSource = { label: entry.source, sourceUrl: entry.sourceUrl };
  const field = DRIVER_FIELD[key];
  const value = input[field];
  const drivers: SizingDriver[] = [];
  let tier: SizingTier = 'insufficient_input';

  if (value != null && Number.isFinite(value) && value > 0) {
    drivers.push({ name: entry.driver, value });
    tier = tierByThresholds(value, entry.thresholds);
  }

  return {
    product: key,
    tier,
    drivers,
    tierSource,
    advisory: true,
    disclaimer: BASE_DISCLAIMER,
    assumptions: tier === 'insufficient_input'
      ? [`${key}의 주 스케일 드라이버 값이 없어 티어를 낼 수 없음(드라이버: ${entry.driver})`]
      : ['헤드룸 20~30% 권장', 'HA/DR 구성 시 이중화 반영 필요', '로그 보존 요구가 스토리지 사이징에 별도 영향', '임계값은 잠정 현장 휴리스틱 — 공식 Sizing Guide로 확정 필요'],
  };
}
