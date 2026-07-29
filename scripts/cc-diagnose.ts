/** Map captured CC API pool → ConfigState → evaluate against CC spec → Korean report. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSpec, evaluateSpec, renderAdvisoryReport } from '../packages/sangfor-spec/src/index.js';
import { diagnosisCaptureFromEnv } from './diagnosis-bundle-io.js';

const capture = diagnosisCaptureFromEnv('CC');

mkdirSync('outputs/diagnosis', { recursive: true });
writeFileSync('outputs/diagnosis/CC_3.0.98_configstate.json', JSON.stringify({
  product: 'CYBER_COMMAND', version: '3.0.98',
  collectedFrom: 'sanitized encrypted capture bundle (read-only)',
  endpoints: capture.endpointsCaptured, observed: capture.observed,
}, null, 2));

const spec = loadSpec('CYBER_COMMAND', '3.0.98')!;
const result = evaluateSpec(spec, capture.observed);
const report = renderAdvisoryReport(spec, result) + `\n\n> 수집: sanitized encrypted capture bundle ${capture.endpointsCaptured}개 엔드포인트 (read-only)\n`;
writeFileSync('outputs/diagnosis/CC_3.0.98_live_diagnosis.md', report);

console.log('observed keys:', Object.keys(capture.observed).join(', '));
console.log('summary:', JSON.stringify(result.summary), 'ok:', result.ok);
