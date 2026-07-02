/** IAG 13.0.120 deep-config advisory from human-observed console values (2026-07-03).
 *  Read-only. Values were read off the live IAG console by the engineer (provenance=manual),
 *  since the Vue SPA does not expose these settings as machine-readable fields. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { evaluateSpec, renderAdvisoryReport, type IntendedSpec } from '../packages/sangfor-spec/src/index.js';

const spec = JSON.parse(readFileSync('data/specs/IAG/13.0.120/access-audit.spec.json', 'utf8')) as IntendedSpec;
const src = { collector: 'manual', collectedAt: '2026-07-03', endpoint: 'IAG 13.0.120 console (engineer visual read)' };
const observed = {
  // Capacity-based rotation (여유용량기반) — not a fixed day count, so the ≥180-day MUST
  // cannot be verified → stays INDETERMINATE (honest; non-numeric → no gte comparison).
  logRetentionDays: { value: '여유용량기반(capacity-based rotation, 고정 보존일수 아님)', source: src },
  // Web authentication is configured/enabled on the device (설정됨).
  webAuthEnabled: { value: true, source: src },
  // 802.1X not needed in this environment (설정 필요하지 않음) → context_dependent, not a misconfig.
  dot1xEnabled: { value: false, source: src },
};

const result = evaluateSpec(spec, observed);
const report = renderAdvisoryReport(spec, result)
  + `\n\n> 수집: 10.80.1.108 IAG 13.0.120 실장비, 담당 엔지니어 육안 확인 (human-observed, 2026-07-03).`
  + `\n> - 로그 보존: **여유용량기반**(고정 보존일수 아님 → ≥180일 요건 보장 여부 판정 불가; 규정 준수가 필요하면 고정 보존기간 정책 검토 권장).`
  + `\n> - 웹 인증: **설정됨**(추후 설정 변경 예정 — 변경 후 재검증 권장).`
  + `\n> - 802.1X: **환경상 불필요**(의도된 미설정 → 환경 의존).\n`;

mkdirSync('outputs/diagnosis', { recursive: true });
writeFileSync('outputs/diagnosis/IAG_13.0.120_deep_config_2026-07-03.md', report);
console.log('summary:', JSON.stringify(result.summary), 'ok:', result.ok);
