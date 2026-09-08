/** Korean advisory report in markdown. */

import type { Category, EvaluationResult, IntendedSpec, ItemResult } from './types.js';

/** Render a Korean advisory report separating 잘못된 설정 / 추가 필요 / 판정 불가 / 정상. */
export function renderAdvisoryReport(spec: IntendedSpec, result: EvaluationResult): string {
  const byCat = (c: Category) => result.items.filter((i) => i.category === c);
  const cite = (id: string) => {
    const item = spec.items.find((s) => s.id === id);
    const src = item?.source;
    return src ? ` \n  - 근거: ${src.manual}${src.section ? ` — ${src.section}` : ''}${src.page ? `\n  - 출처: ${src.page}` : ''}` : ' \n  - 근거: (출처 없음 — 시니어 검토 필요)';
  };
  const provenance = (i: ItemResult) => {
    if (i.observed === undefined) return ''; // nothing observed → provenance N/A
    const s = i.observedSource;
    if (s && (s.endpoint || s.collectedAt)) {
      // This is the COLLECTOR'S claim (how the value was captured), NOT a
      // vendor-verified citation — label it as such and flag unknown collectors.
      const known = new Set(['live-xhr', 'dom-scrape', 'aside-snapshot', 'manual']);
      const collectorTag = s.collector
        ? ` [${s.collector}${known.has(s.collector) ? '' : ' ⚠ 미확인 수집기'}]`
        : '';
      return ` \n  - 관측(수집기 주장, 미검증): ${s.endpoint ?? '(endpoint 미기록)'}${s.collectedAt ? ` @ ${s.collectedAt}` : ''}${collectorTag}`;
    }
    return ` \n  - 관측: 관측 근거 미기록`;
  };
  const line = (i: ItemResult) => {
    const ev = i.observed !== undefined ? ` (기대: ${JSON.stringify(i.expected)}, 실제: ${JSON.stringify(i.observed)})` : (i.expected !== undefined ? ` (기대: ${JSON.stringify(i.expected)}, 실제: 확인 불가)` : '');
    const senior = spec.items.find((s) => s.id === i.id)?.needsSeniorReview ? ' ⚠ 시니어 검토 필요' : '';
    return `- **${i.label}**${senior}${ev}${cite(i.id)}${provenance(i)}`;
  };
  const section = (title: string, cat: Category, empty: string) => {
    const items = byCat(cat);
    return `## ${title} (${items.length})\n\n${items.length ? items.map(line).join('\n\n') : `_${empty}_`}\n`;
  };

  const s = result.summary;
  return [
    `# Sangfor 설정 자문 리포트 — ${spec.product} ${spec.version ?? ''}`.trim(),
    ``,
    `> ⚠️ **면책**: 본 리포트는 AI가 수집된 제품 매뉴얼을 근거로 생성한 **참고용 자문**입니다. 최종 판단과 적용은 담당 엔지니어의 책임입니다. AI는 어떤 장비 설정도 변경하지 않았습니다(read-only).`,
    ``,
    `- 대상 제품/버전: **${spec.product} ${spec.version ?? ''}**`,
    `- 요약: 잘못됨 ${s.misconfiguration} · 추가 필요 ${s.missing} · 환경 의존 ${s.contextDependent} · 판정 불가 ${s.indeterminate} · 정상 ${s.pass}`,
    `- 종합 판정(ok): **${result.ok ? '정상' : '조치 필요'}**`,
    ``,
    section('잘못된 설정 (misconfiguration)', 'misconfiguration', '없음'),
    section('추가로 필요 (missing/recommended)', 'missing', '없음'),
    `## 환경 의존 (context_dependent — 고객 환경 프로파일 확인 필요, 조건부) (${byCat('context_dependent').length})\n\n권장 기준과 다르지만, 고객 환경(규모·망분리·컴플라이언스·업무 앱)에 따라 의도된 구성일 수 있습니다. 아래 항목은 잘못된 설정으로 단정하지 않으며, 담당 엔지니어가 환경 프로파일과 대조해 확정해야 합니다.\n\n${byCat('context_dependent').length ? byCat('context_dependent').map(line).join('\n\n') : '_없음_'}\n`,
    section('판정 불가 (indeterminate — 설정값 미확인/근거 부족)', 'indeterminate', '없음'),
    section('정상 (ok)', 'ok', '없음'),
    `## 커버리지 (감사 범위)`,
    ``,
    `- 스펙 항목 ${result.coverage.specifiedTotal}개 중 관측값 미확인 ${result.coverage.unobservedItems.length}개${result.coverage.unobservedItems.length ? ` (${result.coverage.unobservedItems.join(', ')})` : ''}`,
    `- 스펙 외 관측 키 ${result.coverage.unspecifiedKeys.length}개${result.coverage.unspecifiedKeys.length ? ` (감사 대상: ${result.coverage.unspecifiedKeys.join(', ')})` : ' — 의도 항목 외 설정 없음'}`,
    ``,
    `---`,
    ``,
    `## 사람 최종 확인 (sign-off)`,
    ``,
    `- [ ] 위 잘못된 설정 항목을 담당 엔지니어가 검토하고 조치 여부를 결정함`,
    `- [ ] 판정 불가 항목의 실제 설정값을 사람이 직접 확인함`,
    `- 담당 엔지니어: ____________  일자: __________`,
    ``,
  ].join('\n');
}
