/** EPP 6.0.4 live diagnosis from a dated CDP capture (read-only). Preserves the prior
 *  diagnosis by writing dated output. Login via aside (captcha workflow); config XHR pool
 *  captured via Chrome CDP (the app's own authenticated XHRs). */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadSpec, evaluateSpec, renderAdvisoryReport } from '../packages/sangfor-spec/src/index.js';
import { mapEppPoolToConfigState } from '../packages/sangfor-config-state/src/index.js';

const DATE = process.env.CAP_DATE ?? '2026-07-03';
const pool = JSON.parse(readFileSync('/tmp/dev-captcha/EPP_pool.json', 'utf8'));
const mapped = mapEppPoolToConfigState(pool, { collector: 'live-xhr' });

mkdirSync('outputs/diagnosis', { recursive: true });
writeFileSync(`outputs/diagnosis/EPP_6.0.4_configstate_${DATE}.json`, JSON.stringify({
  product: 'EPP', version: '6.0.4',
  collectedFrom: '10.80.1.106 live console XHR (read-only, Chrome CDP)',
  endpoints: mapped.endpointsCaptured, mappedKeys: mapped.mappedKeys, observed: mapped.observed,
}, null, 2));

const spec = loadSpec('EPP', '6.0.4')!;
const result = evaluateSpec(spec, mapped.observed);
const report = renderAdvisoryReport(spec, result)
  + `\n\n> 수집: 10.80.1.106 라이브 콘솔 XHR ${mapped.endpointsCaptured}개 엔드포인트 (read-only, ${DATE}). 로그인=aside(캡차 워크플로), 추출=Chrome CDP(앱 자신의 인증 XHR 캡처 — aside는 XHR/CSRF 한계로 추출 불가).`
  + `\n> 관측 4값: patchIsLatest=최신, vulnDefUpdateAvailable=false(정의 최신), vulnerabilityCount=0, maliciousDomainBlockCount=35.`
  + `\n> 미도달(판정불가): baseline/getRule(보안 베이스라인 규칙), DAR 모니터링, 그리고 exists-기반 항목(격리/자동업데이트/격리정책/EDR/디바이스컨트롤/예외) — 해당 콘솔 페이지 미방문. 억지 판정 안 함.\n`;
writeFileSync(`outputs/diagnosis/EPP_6.0.4_live_diagnosis_${DATE}.md`, report);
console.log('summary:', JSON.stringify(result.summary), 'ok:', result.ok, 'endpoints:', mapped.endpointsCaptured, 'mapped:', mapped.mappedKeys.join(','));
