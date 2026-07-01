/**
 * @sangfor/sizing — ADVISORY sizing tiering. Deliberately does NOT invent an exact
 * appliance model or node count (that would be fabrication). It maps the primary
 * scale driver to a tier (small/medium/large/xlarge) and always defers the exact
 * BOM to the official Sizing Guide + SE validation.
 */

export type SizingTier = 'insufficient_input' | 'small' | 'medium' | 'large' | 'xlarge';

export interface SizingInput {
  concurrentUsers?: number; // IAG
  endpoints?: number;       // EPP
  vmCount?: number;         // HCI
  eventsPerSecond?: number; // CC
  throughputMbps?: number;  // NGFW
}

export interface SizingDriver { name: string; value: number; }

export interface SizingResult {
  product: string;
  tier: SizingTier;
  drivers: SizingDriver[];
  advisory: true;
  disclaimer: string;
  assumptions: string[];
}

const DISCLAIMER = '자문용 티어 추정입니다. 정확한 모델/노드/라이선스는 공식 Sangfor Sizing Guide와 SE 검증으로 확정하세요. AI는 정확한 BOM을 단정하지 않습니다.';

function tierByThresholds(value: number, [s, m, l]: [number, number, number]): SizingTier {
  if (value <= s) return 'small';
  if (value <= m) return 'medium';
  if (value <= l) return 'large';
  return 'xlarge';
}

export function recommendSizing(product: string, input: SizingInput): SizingResult {
  const p = String(product ?? '').trim().toUpperCase();
  const drivers: SizingDriver[] = [];
  let tier: SizingTier = 'insufficient_input';

  const pick = (name: string, value: number | undefined, thresholds: [number, number, number]) => {
    if (value == null || !Number.isFinite(value) || value <= 0) return false; // reject negative/zero/NaN/Infinity
    drivers.push({ name, value });
    tier = tierByThresholds(value, thresholds);
    return true;
  };

  if (/IAG|SWG/.test(p)) pick('concurrent users', input.concurrentUsers, [1000, 5000, 20000]);
  else if (/EPP|ENDPOINT/.test(p)) pick('managed endpoints', input.endpoints, [500, 2000, 10000]);
  else if (/HCI|SCP/.test(p)) pick('VM count', input.vmCount, [50, 200, 1000]);
  else if (/CC|NDR|CYBER/.test(p)) pick('events per second', input.eventsPerSecond, [2000, 10000, 50000]);
  else if (/NGFW|FIREWALL/.test(p)) pick('throughput (Mbps)', input.throughputMbps, [1000, 5000, 20000]);

  return {
    product: p,
    tier,
    drivers,
    advisory: true,
    disclaimer: DISCLAIMER,
    assumptions: tier === 'insufficient_input'
      ? [`${p}의 주 스케일 드라이버 값이 없어 티어를 낼 수 없음(예: IAG=동시사용자, EPP=엔드포인트, HCI=VM수)`]
      : ['헤드룸 20~30% 권장', 'HA/DR 구성 시 이중화 반영 필요', '로그 보존 요구가 스토리지 사이징에 별도 영향'],
  };
}
