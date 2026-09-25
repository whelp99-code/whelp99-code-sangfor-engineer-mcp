import type { HciVolume } from './volumes.js';
import type { HciInventoryCollection } from './inventory.js';

// Read-only HCI operations health summary derived from the inventory. Pure: it
// makes no requests and mutates nothing. A volume whose status starts with
// 'error' is unhealthy. Missing/partial collection and unknown/transitional states
// are indeterminate; absence of an error alone is never evidence of health.

export interface HciHealthSummary {
  volumeCount: number;
  byStatus: Record<string, number>;
  errorVolumes: Array<{ id: string; name: string; status: string }>;
  serverCount: number;
  imageCount: number;
  verdict: 'PASS' | 'FAIL' | 'INDETERMINATE';
  scope: 'volume-status';
  collection: HciInventoryCollection;
  assessment: { mode: 'snapshot' | 'current'; collectedAt: string | null; evaluatedAt: string | null };
  /** Compatibility flag: true only for an explicit PASS in the declared scope. */
  healthy: boolean;
  findings: string[];
}

export function summarizeHciHealth(
  inventory: { volumes: HciVolume[]; servers: unknown[]; images: unknown[]; collection?: HciInventoryCollection; collectedAt?: string },
  options: { expectedEmpty?: boolean; mode?: 'snapshot' | 'current'; maxAgeSec?: number; now?: string } = {},
): HciHealthSummary {
  const byStatus: Record<string, number> = {};
  for (const v of inventory.volumes) {
    byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
  }
  const errorVolumes = inventory.volumes
    .filter((v) => v.status.startsWith('error'))
    .map((v) => ({ id: v.id, name: v.name, status: v.status }));

  const volumeCount = inventory.volumes.length;
  const collection: HciInventoryCollection = inventory.collection ?? {
    volumes: { status: 'unknown' }, servers: { status: 'unknown' }, images: { status: 'unknown' },
  };
  const complete = Object.values(collection).every((surface) => surface.status === 'complete');
  const unknownVolumes = inventory.volumes.filter((volume) => !['available', 'in-use'].includes(volume.status)
    && !volume.status.startsWith('error'));
  const mode = options.mode ?? 'snapshot';
  const captured = Date.parse(inventory.collectedAt ?? '');
  const now = options.now === undefined ? Date.now() : Date.parse(options.now);
  const age = (now - captured) / 1000;
  const freshnessReason = mode !== 'current' ? null
    : options.maxAgeSec === undefined ? 'freshness-policy-missing: HCI 볼륨 관측 유효시간 정책 없음'
      : !Number.isFinite(options.maxAgeSec) || options.maxAgeSec < 0 ? 'freshness-policy-invalid: 유효시간 정책 오류'
        : !Number.isFinite(age) ? 'evidence-time-unproven: 수집 또는 평가 시각 확인 불가'
          : age < 0 ? 'evidence-future: 미래 시각 관측'
            : age > options.maxAgeSec ? 'evidence-expired: 관측 유효시간 초과' : null;
  const verdict = errorVolumes.length > 0 ? 'FAIL'
    : !freshnessReason && complete && unknownVolumes.length === 0 && (volumeCount > 0 || options.expectedEmpty === true) ? 'PASS'
      : 'INDETERMINATE';
  const healthy = verdict === 'PASS';
  const findings: string[] = [];
  if (freshnessReason) findings.push(freshnessReason);
  if (errorVolumes.length > 0) {
    findings.push(`오류 상태 볼륨 ${errorVolumes.length}개: ${errorVolumes.map((v) => v.name).join(', ')}`);
  }
  if (volumeCount === 0) {
    findings.push(options.expectedEmpty && complete ? '완전한 수집에서 기대한 빈 볼륨 목록을 확인했습니다' : '수집된 볼륨이 없습니다 — 기대 상태 확인 필요');
  }
  for (const [surface, result] of Object.entries(collection)) {
    if (result.status !== 'complete') findings.push(`${surface} 수집 ${result.status}: ${result.reason ?? '완전성 근거 없음'}`);
  }
  if (unknownVolumes.length > 0) {
    findings.push(`전이 중이거나 판정 기준이 없는 볼륨 ${unknownVolumes.length}개`);
  }
  if (healthy && volumeCount > 0) {
    findings.push(`볼륨 ${volumeCount}개 모두 정상 상태`);
  }

  return {
    volumeCount,
    byStatus,
    errorVolumes,
    serverCount: inventory.servers.length,
    imageCount: inventory.images.length,
    verdict,
    scope: 'volume-status',
    collection,
    assessment: { mode, collectedAt: inventory.collectedAt ?? null, evaluatedAt: mode === 'snapshot'
      ? Number.isFinite(captured) ? new Date(captured).toISOString() : null
      : Number.isFinite(now) ? new Date(now).toISOString() : null },
    healthy,
    findings,
  };
}

/**
 * Inventory server/volume counts are not usable capacity, HA topology, or an
 * official N+1 formula. Volume-status PASS must not be reused as capacity PASS.
 */
export function assessHciCapacityOrHaFromInventory(
  inventory: { servers: unknown[]; volumes: HciVolume[]; images?: unknown[] },
): {
  readonly verdict: 'INDETERMINATE';
  readonly scope: 'capacity-or-ha';
  readonly reason: string;
  readonly guideReadyGranted: false;
  readonly inputCounts: { readonly servers: number; readonly volumes: number };
} {
  return {
    verdict: 'INDETERMINATE',
    scope: 'capacity-or-ha',
    reason: 'VM_COUNT_NOT_CAPACITY_OR_HA: inventory server/volume counts are not usable capacity, HA topology, or an official N+1 formula',
    guideReadyGranted: false,
    inputCounts: { servers: inventory.servers.length, volumes: inventory.volumes.length },
  };
}

export function renderHciHealthReport(
  summary: HciHealthSummary,
  meta: { host?: string; collectedAt?: string } = {},
): string {
  const statusLines = Object.entries(summary.byStatus)
    .map(([status, count]) => `| ${status} | ${count} |`)
    .join('\n');
  const errorLines = summary.errorVolumes.length
    ? summary.errorVolumes.map((v) => `- ${v.name} (\`${v.id}\`) — ${v.status}`).join('\n')
    : '_없음_';
  const findingLines = summary.findings.length
    ? summary.findings.map((f) => `- ${f}`).join('\n')
    : '_없음_';

  return [
    `# HCI 운영 점검 리포트${meta.host ? ` — ${meta.host}` : ''}`,
    ``,
    `> ⚠️ **면책**: 본 리포트는 AI가 장비 인벤토리를 read-only로 조회해 생성한 참고용 점검 결과입니다. AI는 어떤 장비 설정도 변경하지 않았습니다(read-only). 최종 판단과 조치는 담당 엔지니어의 책임입니다.`,
    ``,
    `- 수집 시각: ${meta.collectedAt ?? '(미기록)'}`,
    `- 평가: ${summary.assessment.mode === 'current' ? '현재 상태' : '수집 스냅샷 — 현재 상태의 최신성 보장 없음'} (${summary.assessment.evaluatedAt ?? '시각 미확인'})`,
    `- 종합: ${summary.verdict === 'PASS' ? '정상' : summary.verdict === 'FAIL' ? '조치 필요' : '판정 불가'} (${summary.verdict})`,
    `- 판정 범위: 볼륨 상태. 서버·이미지는 목록 수집만 수행하며 클러스터 전체 건강 판정은 포함하지 않음`,
    `- 볼륨 ${summary.volumeCount} · 서버 ${summary.serverCount} · 이미지 ${summary.imageCount}`,
    ``,
    `## 볼륨 상태 분포`,
    ``,
    summary.volumeCount ? `| 상태 | 개수 |\n| --- | --- |\n${statusLines}` : '_수집된 볼륨 없음_',
    ``,
    `## 오류 상태 볼륨`,
    ``,
    errorLines,
    ``,
    `## 점검 소견`,
    ``,
    findingLines,
    ``,
    `---`,
    ``,
    `## 사람 최종 확인 (sign-off)`,
    ``,
    `- [ ] 위 오류/소견 항목을 담당 엔지니어가 검토하고 조치 여부를 결정함`,
    `- 담당 엔지니어: ____________  일자: __________`,
    ``,
  ].join('\n');
}
