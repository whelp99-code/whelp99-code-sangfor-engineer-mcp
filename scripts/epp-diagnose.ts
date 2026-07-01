/** Map captured EPP API pool → ConfigState → evaluate against EPP spec → Korean report. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadSpec, evaluateSpec, renderAdvisoryReport } from '../packages/sangfor-spec/src/index.js';

const pool = JSON.parse(readFileSync('/tmp/dev-captcha/EPP_pool.json', 'utf8'));
const g = (k: string) => pool[`POST /api/edrgoweb/v1/${k}`];
const patch = g('patch/statistics'), vulner = g('vulner/list/homepageVulner'),
  vver = g('vulner/list/version'), baseline = g('baseline/getRule'),
  domain = g('domain_detect/get_domain_info'), dar = g('cnapp/professional/dar/webapi/interval/status');

// Wrap each observed value with its provenance (the XHR endpoint it came from), so
// the report cites the OBSERVED side too — not just the manual on the spec side.
const collectedAt = new Date().toISOString();
const fact = (endpoint: string, value: unknown) => ({ value, source: { endpoint: `POST /api/edrgoweb/v1/${endpoint}`, collectedAt, collector: 'live-xhr' } });

const observed: Record<string, unknown> = {
  patchIsLatest: fact('patch/statistics', patch?.isLatest),
  vulnDefUpdateAvailable: fact('vulner/list/version', vver?.update),
  vulnerabilityCount: fact('vulner/list/homepageVulner', vulner?.vulnerCount),
  securityBaselineRuleCount: fact('baseline/getRule', baseline?.count),
  maliciousDomainBlockCount: fact('domain_detect/get_domain_info', domain?.count),
  darMonitoringActive: fact('cnapp/professional/dar/webapi/interval/status', dar?.interval != null),
  // malwareScanScheduleEnabled: not exposed by captured endpoints → stays INDETERMINATE
};

mkdirSync('outputs/diagnosis', { recursive: true });
writeFileSync('outputs/diagnosis/EPP_6.0.4_configstate.json', JSON.stringify({ product: 'EPP', version: '6.0.4', collectedFrom: '10.80.1.106 live console XHR (read-only)', endpoints: Object.keys(pool).length, observed }, null, 2));

const spec = loadSpec('EPP', '6.0.4')!;
const result = evaluateSpec(spec, observed);
const report = renderAdvisoryReport(spec, result) + `\n\n> 수집: 10.80.1.106 라이브 콘솔 XHR ${Object.keys(pool).length}개 엔드포인트 (read-only, 2026-07-01)\n`;
writeFileSync('outputs/diagnosis/EPP_6.0.4_live_diagnosis.md', report);
console.log('observed:', JSON.stringify(observed));
console.log('summary:', JSON.stringify(result.summary), 'ok:', result.ok);
