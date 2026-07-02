import type { HciVolume } from './volumes.js';

// Read-only HCI operations health summary derived from the inventory. Pure: it
// makes no requests and mutates nothing. A volume whose status starts with
// 'error' is unhealthy; everything else is reported as-observed (no fabrication).

export interface HciHealthSummary {
  volumeCount: number;
  byStatus: Record<string, number>;
  errorVolumes: Array<{ id: string; name: string; status: string }>;
  serverCount: number;
  imageCount: number;
  healthy: boolean;
  findings: string[];
}

export function summarizeHciHealth(
  inventory: { volumes: HciVolume[]; servers: unknown[]; images: unknown[] },
): HciHealthSummary {
  const byStatus: Record<string, number> = {};
  for (const v of inventory.volumes) {
    byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
  }
  const errorVolumes = inventory.volumes
    .filter((v) => v.status.startsWith('error'))
    .map((v) => ({ id: v.id, name: v.name, status: v.status }));

  const volumeCount = inventory.volumes.length;
  const healthy = errorVolumes.length === 0;
  const findings: string[] = [];
  if (errorVolumes.length > 0) {
    findings.push(`오류 상태 볼륨 ${errorVolumes.length}개: ${errorVolumes.map((v) => v.name).join(', ')}`);
  }
  if (volumeCount === 0) {
    findings.push('수집된 볼륨이 없습니다');
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
    healthy,
    findings,
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
    `- 종합: ${summary.healthy ? '정상' : '조치 필요'}`,
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
