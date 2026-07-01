import { describe, expect, it } from 'vitest';
import { evaluateSpec, renderAdvisoryReport, loadSpec } from '../packages/sangfor-spec/src/index.js';

const spec = loadSpec('IAG', '13.0.120')!;
const observed = { logRetentionDays: 30, webAuthEnabled: true, dot1xEnabled: false };
const result = evaluateSpec(spec, observed);
const md = renderAdvisoryReport(spec, result);

describe('renderAdvisoryReport (Korean advisory report)', () => {
  it('separates 잘못된 설정 / 추가 필요 / 정상 sections', () => {
    expect(md).toMatch(/##\s*잘못된 설정/);
    expect(md).toMatch(/##\s*추가(로)? 필요/);
    expect(md).toMatch(/##\s*정상/);
  });

  it('cites the source manual URL for each finding (anti-hallucination evidence)', () => {
    expect(md).toMatch(/support\.sangfor\.com/);
  });

  it('shows expected vs observed for a misconfiguration', () => {
    expect(md).toMatch(/logRetentionDays|로그 보존|Log/i);
    expect(md).toContain('30');
    expect(md).toContain('180');
  });

  it('includes a human sign-off line and a disclaimer (AI must not be the final authority)', () => {
    expect(md).toMatch(/서명|sign-?off|최종 확인|담당 엔지니어/i);
    expect(md).toMatch(/면책|참고용|최종 판단/);
  });

  it('marks INDETERMINATE items as 판정 불가 rather than pass', () => {
    const partial = evaluateSpec(spec, { webAuthEnabled: true });
    const md2 = renderAdvisoryReport(spec, partial);
    expect(md2).toMatch(/##\s*판정 불가/);
  });
});
