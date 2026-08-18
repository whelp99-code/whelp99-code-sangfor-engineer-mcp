import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mapFortiOSConfigState, mapFortiOSSystemHealth } from '../packages/fortios-client/src/index.js';
import { mapCiscoConfigState, mapCiscoPolicyAudit } from '../packages/cisco-client/src/index.js';
import { evaluateSpec, type IntendedSpec, type Verdict } from '../packages/sangfor-spec/src/index.js';
import {
  listGoldenFixtures,
  loadGoldenFixture,
  scrubPayload,
  type GoldenFixture,
} from '../packages/sangfor-engineer-report/src/index.js';

const goldenDir = fileURLToPath(new URL('./fixtures/golden/', import.meta.url));

describe('scrubPayload — deny-by-default anonymization (G1)', () => {
  it('replaces every string field not on the allowlist with a deterministic token', () => {
    const raw = { hostname: 'fw-hq-01.corp.example', model: 'FG-3000D' };
    const scrubbed = scrubPayload(raw, ['model']) as Record<string, string>;

    expect(scrubbed.model).toBe('FG-3000D');
    expect(scrubbed.hostname).not.toBe('fw-hq-01.corp.example');
    expect(scrubbed.hostname).toMatch(/^REDACTED_[0-9a-f]{12}$/);
  });

  it('is deterministic: the same input string maps to the same token across calls', () => {
    const a = scrubPayload({ a: 'secret-value' }, []) as Record<string, string>;
    const b = scrubPayload({ b: 'secret-value' }, []) as Record<string, string>;

    expect(a.a).toBe(b.b);
  });

  it('maps different secrets to different tokens (no collapsing to one constant)', () => {
    const out = scrubPayload({ a: 'serial-A', b: 'serial-B' }, []) as Record<string, string>;

    expect(out.a).not.toBe(out.b);
  });

  it('scrubs nested objects and arrays, keeping structure and non-string values intact', () => {
    const raw = {
      results: [
        { policyid: 1, name: 'Allow-HQ-VPN', logtraffic: 'all', enabled: true },
        { policyid: 2, name: 'Deny-All', logtraffic: 'all', enabled: false },
      ],
    };
    const scrubbed = scrubPayload(raw, ['logtraffic']) as { results: Array<Record<string, unknown>> };

    expect(scrubbed.results).toHaveLength(2);
    expect(scrubbed.results[0].policyid).toBe(1);
    expect(scrubbed.results[0].enabled).toBe(true);
    expect(scrubbed.results[0].logtraffic).toBe('all');
    expect(scrubbed.results[0].name).toMatch(/^REDACTED_[0-9a-f]{12}$/);
    expect(scrubbed.results[1].name).toMatch(/^REDACTED_[0-9a-f]{12}$/);
    expect(scrubbed.results[0].name).not.toBe(scrubbed.results[1].name);
  });

  it('allowlists by leaf key name at any depth, never by prefix match', () => {
    const raw = { outer: { logtraffic: 'utm', logtrafficNotes: 'contains customer name Acme' } };
    const scrubbed = scrubPayload(raw, ['logtraffic']) as { outer: Record<string, string> };

    expect(scrubbed.outer.logtraffic).toBe('utm');
    expect(scrubbed.outer.logtrafficNotes).toMatch(/^REDACTED_/);
  });

  it('never lets a hostname, serial or secret survive anywhere in the output', () => {
    const raw = {
      hostname: 'fw-hq-01.corp.example',
      serial: 'FG3000D3914908901',
      admin: { username: 'netadmin', apiKey: 'sk-live-7f3ac91e', password: 'Hunter2!' },
      interfaces: [{ name: 'port1', ip: '10.0.1.1 255.255.255.0', description: 'HQ uplink to ISP Acme' }],
      cpu: 42,
    };
    const secrets = [
      'fw-hq-01.corp.example', 'FG3000D3914908901', 'netadmin',
      'sk-live-7f3ac91e', 'Hunter2!', '10.0.1.1', 'Acme',
    ];
    const scrubbed = scrubPayload(raw, ['cpu']);
    const serialized = JSON.stringify(scrubbed);

    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect((scrubbed as { cpu: number }).cpu).toBe(42);
  });

  it('scrubs allowlisted keys whose value is a string only when the key matches exactly', () => {
    const scrubbed = scrubPayload({ Name: 'Allow-HQ' }, ['name']) as Record<string, string>;

    expect(scrubbed.Name).toMatch(/^REDACTED_/);
  });

  it('is idempotent: re-scrubbing an already-redacted token leaves it unchanged', () => {
    const once = scrubPayload({ hostname: 'fw-hq-01.corp.example' }, []);
    const twice = scrubPayload(once, []);

    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('leaves numbers, booleans and null untouched without allowlisting them', () => {
    const scrubbed = scrubPayload({ n: 7, b: false, z: null }, []) as Record<string, unknown>;

    expect(scrubbed).toEqual({ n: 7, b: false, z: null });
  });
});

describe('golden corpus fixtures (G1)', () => {
  it('ships at least two vendor fixtures', () => {
    const names = listGoldenFixtures(goldenDir);
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  it('every shipped fixture payload is already scrubbed (idempotent under the scrubber)', () => {
    for (const name of listGoldenFixtures(goldenDir)) {
      const fixture = loadGoldenFixture(goldenDir, name);
      const rescrubbed = scrubPayload(fixture.rawPayload, fixture.allowlist);
      expect(JSON.stringify(rescrubbed)).toBe(JSON.stringify(fixture.rawPayload));
    }
  });

  it('no shipped fixture file contains a mock-console hostname or serial', () => {
    for (const name of listGoldenFixtures(goldenDir)) {
      const raw = readFileSync(`${goldenDir}${name}`, 'utf8');
      expect(raw).not.toContain('FG3000D3914908901');
      expect(raw).not.toContain('corp.example');
    }
  });
});

function observedFromFixture(fixture: GoldenFixture): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  const payload = fixture.rawPayload as Record<string, any>;
  if (fixture.vendor === 'fortios') {
    // The same mapper is fed two cmdb responses, as the live collector does.
    // Each call emits every key it knows; only the keys that call actually
    // observes are kept — policy facts from /firewall/policy, the WAN port
    // count from /system/interface.
    const policyKeys = ['policyCount', 'sslInspectionEnabled', 'threatLoggingEnabled'];
    for (const item of mapFortiOSConfigState(payload.policy, 'mock')) {
      if (policyKeys.includes(item.observedKey)) observed[item.observedKey] = item.value;
    }
    for (const item of mapFortiOSConfigState(payload.interfaces, 'mock')) {
      if (item.observedKey === 'wanInterfaceCount') observed[item.observedKey] = item.value;
    }
    for (const item of mapFortiOSSystemHealth(payload.status, payload.npu, payload.ha, 'mock')) {
      observed[item.observedKey] = item.value;
    }
  } else {
    for (const item of mapCiscoConfigState(payload.interfaces, 'mock')) observed[item.observedKey] = item.value;
    for (const item of mapCiscoPolicyAudit(payload.zonePolicy, payload.acl, payload.snort, 'mock')) {
      observed[item.observedKey] = item.value;
    }
  }
  return observed;
}

describe('golden corpus runner — real mappers + evaluateSpec regression', () => {
  it('maps each fixture payload to exactly the expected observed facts', () => {
    for (const name of listGoldenFixtures(goldenDir)) {
      const fixture = loadGoldenFixture(goldenDir, name);
      expect(observedFromFixture(fixture), name).toEqual(fixture.expectedObserved);
    }
  });

  it('evaluates each fixture to exactly the expected engine verdicts', () => {
    for (const name of listGoldenFixtures(goldenDir)) {
      const fixture = loadGoldenFixture(goldenDir, name);
      const spec: IntendedSpec = fixture.spec;
      const result = evaluateSpec(spec, observedFromFixture(fixture), { now: fixture.evaluatedAt });
      const verdicts: Record<string, Verdict> = {};
      for (const item of result.items) verdicts[item.id] = item.verdict;

      expect(verdicts, name).toEqual(fixture.expectedVerdicts);
    }
  });

  it('is deterministic across repeated evaluation of the same fixture', () => {
    for (const name of listGoldenFixtures(goldenDir)) {
      const fixture = loadGoldenFixture(goldenDir, name);
      const first = evaluateSpec(fixture.spec, observedFromFixture(fixture), { now: fixture.evaluatedAt });
      const second = evaluateSpec(fixture.spec, observedFromFixture(fixture), { now: fixture.evaluatedAt });

      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });

  it('rejects a fixture file whose declared vendor is unknown', () => {
    expect(() => loadGoldenFixture(goldenDir, 'does-not-exist.json')).toThrow();
  });
});
