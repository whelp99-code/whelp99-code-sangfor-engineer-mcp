/** IAG 13.0.120 deep-config advisory from human-observed console values (2026-07-03).
 *  Read-only. Values were read off the live IAG console by the engineer (provenance=manual),
 *  since the Vue SPA does not expose these settings as machine-readable fields. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { evaluateSpec, loadSpec, renderAdvisoryReport } from '../packages/sangfor-spec/src/index.js';
import { diagnosisCaptureFromEnv } from './diagnosis-bundle-io.js';

const capture = diagnosisCaptureFromEnv('IAG');
const spec = loadSpec('IAG', capture.firmwareVersion);
if (!spec) throw new Error(`SPEC_NOT_FOUND: IAG ${capture.firmwareVersion}`);

const result = evaluateSpec(spec, capture.observed);
const report = renderAdvisoryReport(spec, result)
  + `\n\n> 수집: sanitized encrypted capture bundle ${capture.endpointsCaptured}개 엔드포인트 (read-only).\n`;

mkdirSync('outputs/diagnosis', { recursive: true });
writeFileSync('outputs/diagnosis/IAG_13.0.120_deep_config_2026-07-03.md', report);
console.log('summary:', JSON.stringify(result.summary), 'ok:', result.ok);
