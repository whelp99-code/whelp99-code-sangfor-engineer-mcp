/** Map captured CC API pool → ConfigState → evaluate against CC spec → Korean report. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadSpec, evaluateSpec, renderAdvisoryReport } from '../packages/sangfor-spec/src/index.js';
import { mapCcPoolToConfigState } from '../packages/sangfor-config-state/src/index.js';

const pool = JSON.parse(readFileSync('/tmp/dev-captcha/CC_pool.json', 'utf8'));
const mapped = mapCcPoolToConfigState(pool, { collector: 'live-xhr' });

mkdirSync('outputs/diagnosis', { recursive: true });
writeFileSync('outputs/diagnosis/CC_3.0.98_configstate.json', JSON.stringify({
  product: 'CYBER_COMMAND', version: '3.0.98',
  collectedFrom: '10.80.1.107 live console XHR (read-only)',
  endpoints: mapped.endpointsCaptured, observed: mapped.observed,
}, null, 2));

const spec = loadSpec('CYBER_COMMAND', '3.0.98')!;
const result = evaluateSpec(spec, mapped.observed);
const report = renderAdvisoryReport(spec, result) + `\n\n> 수집: 10.80.1.107 라이브 콘솔 XHR ${mapped.endpointsCaptured}개 엔드포인트 (read-only)\n`;
writeFileSync('outputs/diagnosis/CC_3.0.98_live_diagnosis.md', report);

console.log('observed keys:', mapped.mappedKeys.join(', '));
console.log('summary:', JSON.stringify(result.summary), 'ok:', result.ok);
