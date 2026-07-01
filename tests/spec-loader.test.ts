import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec, listSpecCoverage } from '../packages/sangfor-spec/src/index.js';

describe('loadSpec', () => {
  it('loads the IAG 13.0.120 seed spec and merges its items', () => {
    const spec = loadSpec('IAG', '13.0.120');
    expect(spec).not.toBeNull();
    expect(spec!.product).toBe('IAG');
    expect(spec!.items.length).toBeGreaterThanOrEqual(3);
    expect(spec!.items.every((i) => i.source?.page)).toBe(true);
  });

  it('normalizes product aliases (SWG/EPP names) to the spec directory', () => {
    const spec = loadSpec('SWG', '13.0.120');
    expect(spec?.product).toBe('IAG');
  });

  it('uses ENDPOINT_SECURE as the canonical spec product while reading legacy EPP directories', () => {
    const root = mkdtempSpecRoot();
    const dir = join(root, 'EPP', '6.0.4');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.spec.json'), JSON.stringify({
      id: 'spec_epp_agent',
      product: 'EPP',
      version: '6.0.4',
      items: [{
        id: 'agent_online',
        capabilityId: 'endpoint_inventory',
        label: 'Endpoint agent online',
        observedKey: 'agentOnline',
        op: 'eq',
        expected: true,
        severity: 'must',
        source: { manual: 'Endpoint Secure Manual', page: 'p.1' },
      }],
    }));

    const spec = loadSpec('EPP', '6.0.4', root);

    expect(spec?.product).toBe('ENDPOINT_SECURE');
    expect(spec?.id).toBe('spec_ENDPOINT_SECURE_6_0_4');
    expect(spec?.items[0].capabilityId).toBe('endpoint_inventory');
  });

  it('returns null when no spec exists for the product/version', () => {
    expect(loadSpec('IAG', '99.9.9')).toBeNull();
  });

  it('reports which products/versions have specs (coverage)', () => {
    const cov = listSpecCoverage();
    expect(cov).toContainEqual(expect.objectContaining({ product: 'IAG', version: '13.0.120' }));
  });
});

function mkdtempSpecRoot(): string {
  return join(tmpdir(), `sangfor-spec-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
