import { describe, expect, it } from 'vitest';
import {
  computeProductRegistryDigest,
  resolveInjectedAdapterProductCode,
  type AdapterProductCode,
} from '../packages/sangfor-learning-strategy/src/index.js';
import {
  getProductRegistrySnapshot,
  listProductAdapters,
  normalizeAutomationProduct,
  resolveProductAdapterStrict,
  type ProductRegistryView,
} from '../packages/sangfor-product-adapters/src/index.js';

describe('PR-001A1 ADAPTERS-derived registry', () => {
  it('preserves the legacy four-product surface and fallback aliases', () => {
    expect(listProductAdapters().map((adapter) => adapter.product)).toEqual([
      'HCI_SCP', 'IAG', 'ENDPOINT_SECURE', 'NDR',
    ]);
    expect(listProductAdapters().every((adapter) => Object.keys(adapter).sort().join(',') === [
      'aliases', 'apiCatalogStatus', 'apiLikely', 'authMethods', 'capabilities', 'menuRoutes', 'product', 'strategy',
    ].join(','))).toBe(true);
    expect(normalizeAutomationProduct('CC')).toBe('HCI_SCP');
    expect(normalizeAutomationProduct('Athena XDR')).toBe('HCI_SCP');
    expect(normalizeAutomationProduct('A-Sec')).toBe('HCI_SCP');
  });

  it('builds a stable immutable six-entry snapshot with exact alias and spec mappings', () => {
    const first = getProductRegistrySnapshot();
    const second = getProductRegistrySnapshot();
    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(1);
    expect(first.registryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.entries.map((entry) => entry.adapterProduct)).toEqual([
      'HCI_SCP', 'IAG', 'ENDPOINT_SECURE', 'NDR', 'FORTIOS', 'IOSXE',
    ]);
    expect(first.entries.find((entry) => entry.adapterProduct === 'NDR')).toMatchObject({
      observerOnlyAliases: ['athena_xdr', 'cc'],
      specMappingByVariant: {
        CYBER_COMMAND: { lookupCode: 'CYBER_COMMAND', acceptedReturnedCodes: ['CYBER_COMMAND'] },
        ATHENA_XDR: { lookupCode: 'XDR', acceptedReturnedCodes: ['XDR'] },
      },
    });
    expect(first.entries.find((entry) => entry.adapterProduct === 'FORTIOS')).toMatchObject({
      observerOnlyAliases: ['fortigate', 'fortios'],
      defaultSpecMapping: { lookupCode: 'FORTIOS', acceptedReturnedCodes: ['FORTIOS'] },
    });
    expect(first.entries.find((entry) => entry.adapterProduct === 'IOSXE')).toMatchObject({
      observerOnlyAliases: ['cisco_iosxe', 'ios_xe'],
      defaultSpecMapping: { lookupCode: 'CISCO_IOSXE', acceptedReturnedCodes: ['CISCO_IOSXE'] },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(Object.isFrozen(first.entries[0]?.aliases)).toBe(true);
    const copy = structuredClone(first) as ProductRegistryView;
    copy.entries[0]!.aliases.push('mutation');
    expect(first.registryDigest).toBe(second.registryDigest);
    expect(first.entries[0]!.aliases).not.toContain('mutation');
    expect(() => first.entries[0]!.aliases.push('blocked')).toThrow();
  });

  it('keeps legacy aliases as a subset and observer-only aliases as the exact difference', () => {
    const snapshot = getProductRegistrySnapshot();
    const legacyByProduct = new Map(listProductAdapters().map((adapter) => [
      adapter.product,
      new Set(adapter.aliases.map(normalizeAlias)),
    ]));
    for (const entry of snapshot.entries) {
      const legacy = legacyByProduct.get(entry.adapterProduct as 'HCI_SCP' | 'IAG' | 'ENDPOINT_SECURE' | 'NDR') ?? new Set<string>();
      const identity = new Set(entry.aliases);
      expect([...legacy].every((alias) => identity.has(alias))).toBe(true);
      expect(new Set(entry.observerOnlyAliases)).toEqual(new Set([...identity].filter((alias) => !legacy.has(alias))));
    }
  });

  it('strictly resolves identity-only products, variants, and injected branded codes', () => {
    const snapshot = getProductRegistrySnapshot();
    expect(resolveProductAdapterStrict('CC')).toMatchObject({ adapterProduct: 'NDR' });
    expect(resolveProductAdapterStrict('CC').specMappingByVariant.CYBER_COMMAND?.lookupCode).toBe('CYBER_COMMAND');
    expect(resolveProductAdapterStrict({ product: 'Athena XDR', productVariant: 'ATHENA_XDR' }).adapterProduct).toBe('NDR');
    expect(resolveProductAdapterStrict('FortiGate').adapterProduct).toBe('FORTIOS');
    expect(resolveProductAdapterStrict('Cisco IOSXE').adapterProduct).toBe('IOSXE');
    const branded: AdapterProductCode = resolveInjectedAdapterProductCode(snapshot, 'A-Sec');
    expect(branded).toBe('ENDPOINT_SECURE');
  });

  it('fails closed for unknown, ambiguous, and drifted registry inputs', () => {
    expect(() => resolveProductAdapterStrict('not-a-product')).toThrow('UNSUPPORTED_PRODUCT');
    const ambiguous = structuredClone(getProductRegistrySnapshot()) as ProductRegistryView;
    ambiguous.entries[0]!.aliases.push('iag');
    ambiguous.registryDigest = computeProductRegistryDigest(ambiguous.entries);
    expect(() => resolveProductAdapterStrict('iag', { snapshot: ambiguous })).toThrow('AMBIGUOUS_PRODUCT');
    const drifted = structuredClone(getProductRegistrySnapshot()) as ProductRegistryView;
    drifted.registryDigest = '0'.repeat(64);
    expect(() => resolveProductAdapterStrict('IAG', { snapshot: drifted })).toThrow('REGISTRY_DRIFT');
  });

  it('canonicalizes and deduplicates product, alias, mapping, and accepted-code fields', () => {
    const base = {
      adapterProduct: 'demo_product' as AdapterProductCode,
      vendor: 'SANGFOR' as const,
      aliases: ['Demo-Name', 'demo name', 'Other'],
      observerOnlyAliases: ['Other', 'other'],
      observerEligible: true,
      defaultSpecMapping: { lookupCode: 'demo', acceptedReturnedCodes: ['DEMO', 'demo'] as [string, ...string[]] },
      specMappingByVariant: {
        'variant one': { lookupCode: 'lookup', acceptedReturnedCodes: ['B', 'A'] as [string, ...string[]] },
      },
    };
    const equivalent = {
      ...base,
      aliases: ['other', 'DEMO NAME', 'demo-name'],
      observerOnlyAliases: ['other'],
      defaultSpecMapping: { lookupCode: 'DEMO', acceptedReturnedCodes: ['demo'] as [string, ...string[]] },
      specMappingByVariant: { VARIANT_ONE: { lookupCode: 'LOOKUP', acceptedReturnedCodes: ['A', 'B'] as [string, ...string[]] } },
    };
    expect(computeProductRegistryDigest([base])).toBe(computeProductRegistryDigest([equivalent]));
    expect(computeProductRegistryDigest([{ ...base, vendor: 'CISCO' }])).not.toBe(computeProductRegistryDigest([base]));
    expect(computeProductRegistryDigest([{ ...base, observerEligible: false }])).not.toBe(computeProductRegistryDigest([base]));
    expect(computeProductRegistryDigest([{ ...base, defaultSpecMapping: null }])).not.toBe(computeProductRegistryDigest([base]));
    expect(computeProductRegistryDigest([{ ...base, specMappingByVariant: {} }])).not.toBe(computeProductRegistryDigest([base]));
  });
});

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}
