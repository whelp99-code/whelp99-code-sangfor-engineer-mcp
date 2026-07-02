/** Map captured EPP API pool → ConfigState → evaluate against EPP spec → Korean report.
 *  Mapping now lives in @sangfor/config-state (mapEppPoolToConfigState); this script
 *  only does file I/O and rendering so the same logic is reachable from the MCP tool. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadSpec, evaluateSpec, renderAdvisoryReport } from '../packages/sangfor-spec/src/index.js';
import { mapEppPoolToConfigState } from '../packages/sangfor-config-state/src/index.js';

const pool = JSON.parse(readFileSync('/tmp/dev-captcha/EPP_pool.json', 'utf8'));
const mapped = mapEppPoolToConfigState(pool, { collector: 'live-xhr' });

mkdirSync('outputs/diagnosis', { recursive: true });
writeFileSync('outputs/diagnosis/EPP_6.0.4_configstate.json', JSON.stringify({
  product: 'EPP', version: '6.0.4',
  collectedFrom: '10.80.1.106 live console XHR (read-only)',
  endpoints: mapped.endpointsCaptured, observed: mapped.observed,
}, null, 2));

const spec = loadSpec('EPP', '6.0.4')!;
const result = evaluateSpec(spec, mapped.observed);
const report = renderAdvisoryReport(spec, result) + `\n\n> 수집: 10.80.1.106 라이브 콘솔 XHR ${mapped.endpointsCaptured}개 엔드포인트 (read-only)\n`;
writeFileSync('outputs/diagnosis/EPP_6.0.4_live_diagnosis.md', report);
console.log('observed keys:', mapped.mappedKeys.join(', '));
console.log('summary:', JSON.stringify(result.summary), 'ok:', result.ok);
