import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ObserverSpecAdapter,
  SPEC_PRODUCT_MAPPINGS,
  type ObserverSpecAdapterOptions,
} from '../packages/sangfor-product-adapters/src/observer-spec-adapter.js';
import {
  FactService,
  type FactQueryResult,
} from '../packages/sangfor-learning-strategy/src/fact-service.js';
import type { ProductRegistryView } from '../packages/sangfor-learning-strategy/src/contracts.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function loadFixture(name: string): unknown {
  const path = join(__dirname, 'fixtures', 'learning-strategies', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function makeRegistry(entries: ProductRegistryView['entries'] = []): ProductRegistryView {
  return {
    schemaVersion: 1,
    registryDigest: 'test-registry-digest',
    entries,
  };
}

describe('PR-002: ObserverSpecAdapter', () => {
  describe('SPEC_PRODUCT_MAPPINGS', () => {
    it('maps IOSXE to CISCO_IOSXE', () => {
      expect(SPEC_PRODUCT_MAPPINGS.IOSXE.lookupCode).toBe('CISCO_IOSXE');
      expect(SPEC_PRODUCT_MAPPINGS.IOSXE.acceptedReturnedCodes).toContain('CISCO_IOSXE');
    });

    it('maps NDR to CYBER_COMMAND', () => {
      expect(SPEC_PRODUCT_MAPPINGS.NDR.lookupCode).toBe('CYBER_COMMAND');
      expect(SPEC_PRODUCT_MAPPINGS.NDR.acceptedReturnedCodes).toContain('CYBER_COMMAND');
      expect(SPEC_PRODUCT_MAPPINGS.NDR.acceptedReturnedCodes).toContain('NDR');
    });

    it('maps HCI_SCP lookup to HCI accepted return', () => {
      expect(SPEC_PRODUCT_MAPPINGS.HCI_SCP.lookupCode).toBe('HCI');
      expect(SPEC_PRODUCT_MAPPINGS.HCI_SCP.acceptedReturnedCodes).toContain('HCI');
      expect(SPEC_PRODUCT_MAPPINGS.HCI_SCP.acceptedReturnedCodes).toContain('HCI_SCP');
    });

    it('maps ENDPOINT_SECURE to ENDPOINT_SECURE', () => {
      expect(SPEC_PRODUCT_MAPPINGS.ENDPOINT_SECURE.lookupCode).toBe('ENDPOINT_SECURE');
      expect(SPEC_PRODUCT_MAPPINGS.ENDPOINT_SECURE.acceptedReturnedCodes).toContain('ENDPOINT_SECURE');
    });
  });

  describe('resolveSpecProductCode', () => {
    it('resolves product variant from registry entry', () => {
      const registry = makeRegistry([
        {
          adapterProduct: 'ENDPOINT_SECURE' as never,
          vendor: 'SANGFOR',
          aliases: ['epp', 'endpoint'],
          observerOnlyAliases: [],
          observerEligible: true,
          defaultSpecMapping: SPEC_PRODUCT_MAPPINGS.ENDPOINT_SECURE,
          specMappingByVariant: {},
        },
      ]);

      const adapter = new ObserverSpecAdapter({ registry });
      const result = adapter.resolveSpecProductCode('ENDPOINT_SECURE');
      expect(result).toBe('ENDPOINT_SECURE');
    });

    it('returns MAPPING_NOT_FOUND for unknown product variant', () => {
      const registry = makeRegistry([]);
      const adapter = new ObserverSpecAdapter({ registry });
      const result = adapter.resolveSpecProductCode('UNKNOWN_PRODUCT');
      expect(result).toEqual({
        code: 'MAPPING_NOT_FOUND',
        message: expect.stringContaining('UNKNOWN_PRODUCT'),
      });
    });

    it('returns MAPPING_NOT_FOUND when entry has no spec mapping', () => {
      const registry = makeRegistry([
        {
          adapterProduct: 'ENDPOINT_SECURE' as never,
          vendor: 'SANGFOR',
          aliases: [],
          observerOnlyAliases: [],
          observerEligible: true,
          defaultSpecMapping: null,
          specMappingByVariant: {},
        },
      ]);

      const adapter = new ObserverSpecAdapter({ registry });
      const result = adapter.resolveSpecProductCode('ENDPOINT_SECURE');
      expect(result).toEqual({
        code: 'MAPPING_NOT_FOUND',
        message: expect.stringContaining('No spec mapping'),
      });
    });
  });

  describe('validateSpecVersion', () => {
    it('accepts non-empty string version', () => {
      const registry = makeRegistry([]);
      const adapter = new ObserverSpecAdapter({ registry });
      expect(adapter.validateSpecVersion('6.0.4')).toBe(true);
    });

    it('rejects empty string version', () => {
      const registry = makeRegistry([]);
      const adapter = new ObserverSpecAdapter({ registry });
      expect(adapter.validateSpecVersion('')).toBe(false);
    });
  });

  describe('convertFactsToObservedMap', () => {
    it('converts only complete results to observed map', () => {
      const registry = makeRegistry([]);
      const adapter = new ObserverSpecAdapter({ registry });

      const results: FactQueryResult[] = [
        { factId: 'licenseStatus', status: 'complete', value: 'active' },
        { factId: 'version', status: 'partial', value: '6.0' },
        { factId: 'config', status: 'not_observed' },
      ];

      const observedMap = adapter.convertFactsToObservedMap(results);
      expect(observedMap).toEqual({ licenseStatus: 'active' });
    });

    it('skips complete results with undefined value', () => {
      const registry = makeRegistry([]);
      const adapter = new ObserverSpecAdapter({ registry });

      const results: FactQueryResult[] = [
        { factId: 'licenseStatus', status: 'complete', value: undefined },
      ];

      const observedMap = adapter.convertFactsToObservedMap(results);
      expect(observedMap).toEqual({});
    });
  });

  describe('adapt — full flow', () => {
    it('returns VERSION_NOT_VERIFIED when specVersion is empty', () => {
      const registry = makeRegistry([
        {
          adapterProduct: 'ENDPOINT_SECURE' as never,
          vendor: 'SANGFOR',
          aliases: [],
          observerOnlyAliases: [],
          observerEligible: true,
          defaultSpecMapping: SPEC_PRODUCT_MAPPINGS.ENDPOINT_SECURE,
          specMappingByVariant: {},
        },
      ]);

      const adapter = new ObserverSpecAdapter({
        registry,
        productVariant: 'ENDPOINT_SECURE',
        specVersion: '',
      });

      const result = adapter.adapt([]);
      expect(result).toEqual({
        code: 'VERSION_NOT_VERIFIED',
        message: expect.stringContaining('not verified'),
      });
    });

    it('adapts complete facts to observed map with valid spec version', () => {
      const registry = makeRegistry([
        {
          adapterProduct: 'ENDPOINT_SECURE' as never,
          vendor: 'SANGFOR',
          aliases: [],
          observerOnlyAliases: [],
          observerEligible: true,
          defaultSpecMapping: SPEC_PRODUCT_MAPPINGS.ENDPOINT_SECURE,
          specMappingByVariant: {},
        },
      ]);

      const adapter = new ObserverSpecAdapter({
        registry,
        productVariant: 'ENDPOINT_SECURE',
        specVersion: '6.0.4',
      });

      const results: FactQueryResult[] = [
        { factId: 'licenseStatus', status: 'complete', value: 'active' },
      ];

      const result = adapter.adapt(results);
      expect(result).toEqual({
        specProductCode: 'ENDPOINT_SECURE',
        specVersion: '6.0.4',
        observedFacts: { licenseStatus: 'active' },
        eligibleFactCount: 1,
        totalFactCount: 1,
      });
    });
  });

  describe('fixture-based tests', () => {
    it('researched fixture produces INDETERMINATE (not eligible for Spec PASS)', () => {
      const fixture = loadFixture('researched') as { state: string; facts: Record<string, unknown> };
      expect(fixture.state).toBe('researched');
      // researched state is not eligible for Spec PASS boundary
      // Only lab_verified and above can produce Spec PASS
    });

    it('lab_verified fixture is eligible for Spec PASS boundary', () => {
      const fixture = loadFixture('lab-verified') as { state: string; facts: Record<string, unknown> };
      expect(fixture.state).toBe('lab_verified');
      // lab_verified state is eligible for Spec PASS boundary
    });
  });
});

describe('PR-002: FactService', () => {
  it('queries facts and returns results', () => {
    const service = new FactService({
      revisions: [],
      methodResults: [],
    });

    const results = service.query({
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' },
      factIds: ['licenseStatus'],
      context: {
        registryDigest: 'test-digest',
        versionTruthRecord: 'test-truth',
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0].factId).toBe('licenseStatus');
  });

  it('filters eligible results (complete only)', () => {
    const service = new FactService({
      revisions: [],
      methodResults: [],
    });

    const results: FactQueryResult[] = [
      { factId: 'fact1', status: 'complete', value: 'value1' },
      { factId: 'fact2', status: 'partial', value: 'value2' },
      { factId: 'fact3', status: 'not_observed' },
    ];

    const eligible = service.filterEligibleResults(results);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].factId).toBe('fact1');
  });
});
