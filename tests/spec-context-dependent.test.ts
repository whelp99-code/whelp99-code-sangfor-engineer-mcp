import { describe, expect, it } from 'vitest';
import { evaluateSpec, renderAdvisoryReport, type IntendedSpec } from '../packages/sangfor-spec/src/index.js';

const spec: IntendedSpec = {
  id: 'iag-ctx-test',
  product: 'IAG',
  version: '13.0.120',
  items: [
    {
      id: 'ssl-decrypt', capabilityId: 'ssl', label: 'SSL 복호화 예외',
      observedKey: 'sslDecryptExceptions', op: 'gte', expected: 1, severity: 'recommended',
      contextDependent: true, source: { manual: 'IAG User Manual v13.0.120', section: 'Proxy > SSL Decryption' },
    },
    {
      id: 'ha', capabilityId: 'ha', label: 'HA',
      observedKey: 'haEnabled', op: 'eq', expected: true, severity: 'recommended',
      source: { manual: 'IAG User Manual v13.0.120', section: 'System > HA' },
    },
  ],
};

describe('context_dependent classification', () => {
  it('routes a deviating contextDependent item to its own category (not misconfiguration/missing)', () => {
    const r = evaluateSpec(spec, { sslDecryptExceptions: 0, haEnabled: false });
    const ctx = r.items.find((i) => i.id === 'ssl-decrypt');
    expect(ctx?.category).toBe('context_dependent');
    expect(r.summary.contextDependent).toBe(1);
    expect(r.summary.missing).toBe(1);          // ha keeps its usual classification
    expect(r.ok).toBe(false);                   // a conditional item still blocks ok
  });

  it('renders a dedicated Korean section', () => {
    const r = evaluateSpec(spec, { sslDecryptExceptions: 0, haEnabled: true });
    expect(renderAdvisoryReport(spec, r)).toContain('환경 의존');
  });
});
