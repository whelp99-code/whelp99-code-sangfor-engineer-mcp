import { describe, expect, it } from 'vitest';
import {
  getProductRegistrySnapshot,
  listProductAdapters,
  normalizeAutomationProduct,
  resolveProductAdapterStrict,
  type ProductRegistryView,
} from '../packages/sangfor-product-adapters/src/index.js';
import * as productAdapterRuntime from '../packages/sangfor-product-adapters/src/index.js';

describe('PR-001A1 ADAPTERS-derived registry snapshot', () => {
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
    expect(productAdapterRuntime).not.toHaveProperty('ADAPTERS');
    expect(productAdapterRuntime).not.toHaveProperty('getProductAdapterRegistryEntryStrict');
    const copy = structuredClone(first) as ProductRegistryView;
    copy.entries[0]!.aliases.push('mutation');
    expect(first.registryDigest).toBe(second.registryDigest);
    expect(getProductRegistrySnapshot().registryDigest).toBe(first.registryDigest);
    expect(first.entries[0]!.aliases).not.toContain('mutation');
    expect(() => first.entries[0]!.aliases.push('blocked')).toThrow();
    expect(Object.isFrozen(listProductAdapters()[0])).toBe(false);
    const legacyIag = listProductAdapters().find((adapter) => adapter.product === 'IAG')!;
    const originalLegacyAliases = [...legacyIag.aliases];
    legacyIag.aliases.push('temporary legacy alias');
    try {
      expect(legacyIag.aliases).toContain('temporary legacy alias');
      const duringLegacyMutation = getProductRegistrySnapshot();
      expect(duringLegacyMutation).toEqual(first);
      expect(resolveProductAdapterStrict('IAG').adapterProduct).toBe('IAG');
    } finally {
      legacyIag.aliases.splice(0, legacyIag.aliases.length, ...originalLegacyAliases);
    }
    expect(legacyIag.aliases).toEqual(originalLegacyAliases);
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
});

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}
