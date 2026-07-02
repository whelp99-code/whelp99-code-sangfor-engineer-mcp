/** EPP 6.0.4 diagnosis merging live CDP capture (read-only) with engineer-observed
 *  policy-form values (read from the console by a human, 2026-07-03). Values behind
 *  write-button policy pages are human-observed; the rest are captured. Unknown values
 *  are omitted → INDETERMINATE (never guessed). */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadSpec, evaluateSpec, renderAdvisoryReport } from '../packages/sangfor-spec/src/index.js';
import { mapEppPoolToConfigState } from '../packages/sangfor-config-state/src/index.js';

const DATE = '2026-07-03';
const captured = mapEppPoolToConfigState(JSON.parse(readFileSync('/tmp/dev-captcha/EPP_pool.json', 'utf8')), { collector: 'live-xhr' }).observed;

const hsrc = { collector: 'engineer-observed', collectedAt: DATE, endpoint: 'EPP console General Policies (human read)' };
const h = (value: unknown) => ({ value, source: hsrc });
const humanObserved: Record<string, unknown> = {
  securityBaselineRuleCount: h(0),          // 1 = 0 rules
  malwareScanScheduleEnabled: h(true),      // 2 = on
  darMonitoringActive: h(false),            // 3 = off
  endpointIsolationConfigured: h(true),     // 4 = configured
  agentAutoUpdateEnabled: h(true),          // 5 = on
  deviceControlConfigured: h(false),        // 8 = none
  exclusionListManaged: h(false),           // 9 = none
  // 6 quarantineConfigured, 7 edrBehaviorMonitoringEnabled = UNKNOWN → omitted → INDETERMINATE
};

const observed = { ...captured, ...humanObserved };
mkdirSync('outputs/diagnosis', { recursive: true });
writeFileSync(`outputs/diagnosis/EPP_6.0.4_configstate_${DATE}.json`, JSON.stringify({ product: 'EPP', version: '6.0.4', collectedFrom: '10.80.1.106 (CDP read-only XHR + engineer-observed policy values)', observed }, null, 2));

const spec = loadSpec('EPP', '6.0.4')!;
const result = evaluateSpec(spec, observed);
const report = renderAdvisoryReport(spec, result)
  + `\n\n> 수집: 10.80.1.106 EPP 6.0.4 (${DATE}). Read-only. 캡처=CDP XHR(patch/vuln/domain/asset), 정책값=담당 엔지니어 콘솔 육안(baseline=0규칙, 멀웨어스케줄=on, DAR=off, 격리정책=구성, 자동업데이트=on, 디바이스컨트롤=없음, 예외목록=없음).`
  + `\n> quarantine/EDR 항목은 미확인→판정불가(추정 안 함).\n`;
writeFileSync(`outputs/diagnosis/EPP_6.0.4_live_diagnosis_${DATE}.md`, report);
console.log('summary:', JSON.stringify(result.summary), 'ok:', result.ok);
console.log('observed keys:', Object.keys(observed).join(','));
