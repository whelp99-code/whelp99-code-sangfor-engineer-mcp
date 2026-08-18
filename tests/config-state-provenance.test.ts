// A2 — fact-level provenance envelope (docs/plans/designs/002-device-observability-platform.md).
// Every normalized fact must carry transport / endpoint / mapper version / collectedAt,
// and constructing an observed fact WITHOUT provenance must fail closed.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAPPER_VERSION,
  createObservedFact,
  isFactProvenance,
  mapCcPoolToConfigState,
  mapEppPoolToConfigState,
  type FactProvenance,
  type ObservedFactJson,
} from '../packages/sangfor-config-state/src/index.js';

const eppPool = JSON.parse(readFileSync('tests/fixtures/epp-pool.sample.json', 'utf8')) as Record<string, unknown>;

const ccPool = {
  'POST /apps/secvisual/system/system_manage/get_system_info': {
    system_version: '3.0.98C',
    timezone: 'America/Chicago',
    is_version_expired: false,
    is_cert_expired: false,
    lib_info: { is_virus_lib_exist: true },
  },
  'POST /api/v1/clusters/master': { offline: false },
};

const facts = (observed: Record<string, ObservedFactJson>): ObservedFactJson[] => Object.values(observed);

describe('MAPPER_VERSION', () => {
  it('is a non-empty semver string owned by the package (not hardcoded per call site)', () => {
    expect(typeof MAPPER_VERSION).toBe('string');
    expect(MAPPER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('createObservedFact — fail closed without provenance', () => {
  const provenance: FactProvenance = {
    transport: 'browser',
    endpoint: 'POST /api/edrgoweb/v1/patch/statistics',
    mapperVersion: MAPPER_VERSION,
    collectedAt: '2026-07-02T00:00:00.000Z',
    collector: 'test',
  };

  it('builds a fact whose source IS the provenance envelope', () => {
    const fact = createObservedFact(true, provenance);
    expect(fact.value).toBe(true);
    expect(fact.source).toEqual(provenance);
  });

  it('refuses a fact with no provenance at all (typed error, never a defaulted envelope)', () => {
    expect(() => createObservedFact(true, undefined as unknown as FactProvenance)).toThrow(/^MISSING_PROVENANCE:/);
    expect(() => createObservedFact(true, null as unknown as FactProvenance)).toThrow(/^MISSING_PROVENANCE:/);
  });

  it('refuses a fact whose envelope is missing a required field', () => {
    const required: Array<keyof FactProvenance> = ['transport', 'endpoint', 'mapperVersion', 'collectedAt', 'collector'];
    for (const field of required) {
      const partial = { ...provenance };
      delete (partial as Record<string, unknown>)[field];
      expect(() => createObservedFact(true, partial as FactProvenance), `missing ${field} must be refused`)
        .toThrow(/^MISSING_PROVENANCE:/);
    }
  });

  it('refuses an unknown transport and a non-positive measured latency', () => {
    expect(() => createObservedFact(true, { ...provenance, transport: 'carrier-pigeon' as FactProvenance['transport'] }))
      .toThrow(/^MISSING_PROVENANCE:/);
    expect(() => createObservedFact(true, { ...provenance, latencyMs: 0 })).toThrow(/^MISSING_PROVENANCE:/);
    expect(() => createObservedFact(true, { ...provenance, latencyMs: -5 })).toThrow(/^MISSING_PROVENANCE:/);
    expect(createObservedFact(true, { ...provenance, latencyMs: 12 }).source.latencyMs).toBe(12);
  });

  it('exposes a provenance guard that rejects incomplete envelopes', () => {
    expect(isFactProvenance(provenance)).toBe(true);
    expect(isFactProvenance({ ...provenance, mapperVersion: undefined })).toBe(false);
    expect(isFactProvenance(undefined)).toBe(false);
  });
});

describe('mapEppPoolToConfigState — every normalized fact carries a provenance envelope', () => {
  it('stamps transport, endpoint, mapper version and collectedAt on every fact', () => {
    const r = mapEppPoolToConfigState(eppPool, { collectedAt: '2026-07-02T00:00:00Z', collector: 'test' });
    expect(facts(r.observed).length).toBeGreaterThan(0);
    for (const fact of facts(r.observed)) {
      expect(isFactProvenance(fact.source)).toBe(true);
      expect(fact.source.mapperVersion).toBe(MAPPER_VERSION);
      expect(fact.source.transport).toBe('browser'); // XHR pool is captured through the console browser
      expect(fact.source.collectedAt).toBe('2026-07-02T00:00:00Z');
      expect(fact.source.collector).toBe('test');
      expect(fact.source.endpoint).toMatch(/^POST /);
    }
  });

  it('carries the optional envelope fields when the collector measured them', () => {
    const r = mapEppPoolToConfigState(eppPool, {
      collector: 'live-xhr',
      transport: 'api',
      firmwareVersion: '6.0.4',
      latencyMs: 431,
      authPrincipal: 'svc-observer@lab',
      menuPath: ['보안방어', '패치관리'],
    });
    const fact = r.observed.patchIsLatest;
    expect(fact.source.transport).toBe('api');
    expect(fact.source.firmwareVersion).toBe('6.0.4');
    expect(fact.source.latencyMs).toBe(431);
    expect(fact.source.authPrincipal).toBe('svc-observer@lab');
    expect(fact.source.menuPath).toEqual(['보안방어', '패치관리']);
  });

  it('refuses a measured latency of zero or less instead of recording a fake envelope', () => {
    expect(() => mapEppPoolToConfigState(eppPool, { collector: 'test', latencyMs: 0 })).toThrow(/^MISSING_PROVENANCE:/);
  });

  it('keeps the existing wrapper shape ({ value, source }) so evaluateSpec still unwraps facts', () => {
    const r = mapEppPoolToConfigState(eppPool, { collector: 'test' });
    for (const fact of facts(r.observed)) {
      expect(Object.keys(fact).sort()).toEqual(['source', 'value']);
    }
  });
});

describe('mapCcPoolToConfigState — every normalized fact carries a provenance envelope', () => {
  it('stamps the envelope on every CC fact', () => {
    const r = mapCcPoolToConfigState(ccPool, { collectedAt: '2026-07-03T00:00:00Z', collector: 'test', latencyMs: 87 });
    expect(facts(r.observed).length).toBeGreaterThan(0);
    for (const fact of facts(r.observed)) {
      expect(isFactProvenance(fact.source)).toBe(true);
      expect(fact.source.mapperVersion).toBe(MAPPER_VERSION);
      expect(fact.source.collectedAt).toBe('2026-07-03T00:00:00Z');
      expect(fact.source.latencyMs).toBe(87);
      expect(fact.source.endpoint).toMatch(/^POST /);
    }
    expect(r.observed.clusterMasterOffline.source.endpoint).toBe('POST /api/v1/clusters/master');
  });

  it('refuses a measured latency of zero or less', () => {
    expect(() => mapCcPoolToConfigState(ccPool, { collector: 'test', latencyMs: -1 })).toThrow(/^MISSING_PROVENANCE:/);
  });
});
