/** Map captured EPP API pool → ConfigState → evaluate against EPP spec → Korean report.
 *  Mapping now lives in @sangfor/config-state (mapEppPoolToConfigState); this script
 *  only does file I/O and rendering so the same logic is reachable from the MCP tool. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSpec, evaluateSpec, renderAdvisoryReport } from '../packages/sangfor-spec/src/index.js';
import { diagnosisCaptureFromEnv } from './diagnosis-bundle-io.js';

const capture = diagnosisCaptureFromEnv('EPP');

mkdirSync('outputs/diagnosis', { recursive: true });
writeFileSync('outputs/diagnosis/EPP_6.0.4_configstate.json', JSON.stringify({
  product: 'EPP', version: '6.0.4',
  collectedFrom: 'sanitized encrypted capture bundle (read-only)',
  endpoints: capture.endpointsCaptured, observed: capture.observed,
}, null, 2));

const spec = loadSpec('EPP', '6.0.4')!;
const result = evaluateSpec(spec, capture.observed);
const report = renderAdvisoryReport(spec, result) + `\n\n> 수집: sanitized encrypted capture bundle ${capture.endpointsCaptured}개 엔드포인트 (read-only)\n`;
writeFileSync('outputs/diagnosis/EPP_6.0.4_live_diagnosis.md', report);
console.log('observed keys:', Object.keys(capture.observed).join(', '));
console.log('summary:', JSON.stringify(result.summary), 'ok:', result.ok);
