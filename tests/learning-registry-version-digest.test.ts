import { describe, expect, it } from 'vitest';
import {
  computeProductRegistryDigest,
  resolveInjectedAdapterProductCode,
  type AdapterProductCode,
} from '../packages/sangfor-learning-strategy/src/index.js';
import {
  getProductRegistrySnapshot,
  resolveProductAdapterStrict,
  type ProductRegistryView,
} from '../packages/sangfor-product-adapters/src/index.js';

describe('PR-001A1 ADAPTERS-derived registry digest canonicalization', () => {
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
    expect(() => computeProductRegistryDigest([{
      ...base,
      specMappingByVariant: {
        'foo-bar': base.specMappingByVariant['variant one']!,
        'FOO BAR': base.specMappingByVariant['variant one']!,
      },
    }])).toThrow('INVALID_REGISTRY');
    const productCollision = structuredClone(getProductRegistrySnapshot()) as ProductRegistryView;
    const iag = productCollision.entries.find((entry) => entry.adapterProduct === 'IAG')!;
    iag.specMappingByVariant = {
      'foo-bar': { lookupCode: 'IAG', acceptedReturnedCodes: ['IAG'] },
      'FOO BAR': { lookupCode: 'IAG', acceptedReturnedCodes: ['IAG'] },
    };
    expect(() => resolveProductAdapterStrict('IAG', { snapshot: productCollision })).toThrow('INVALID_REGISTRY');
    const invalidVariant = { productVariant: ['CYBER_COMMAND'] } satisfies { readonly productVariant: unknown };
    expect(() => Reflect.apply(resolveInjectedAdapterProductCode, undefined, [getProductRegistrySnapshot(), 'NDR', invalidVariant]))
      .toThrow('SPEC_IDENTITY_MISMATCH');
  });
});
