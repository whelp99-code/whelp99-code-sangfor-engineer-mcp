import { createHash } from 'node:crypto';
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
  type StrictProductResolveOptions,
  type StrictProductResolveRequest,
} from '../packages/sangfor-product-adapters/src/index.js';

function stableTestJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableTestJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableTestJson(record[key])}`).join(',')}}`;
}

function digestWithEmptyAdapterProduct(entries: ProductRegistryView['entries']): string {
  const canonicalEntries = entries.map((entry) => ({
    adapterProduct: entry.adapterProduct.trim().toUpperCase().replace(/[\s-]+/g, '_'),
    vendor: entry.vendor,
    aliases: [...entry.aliases].sort(),
    observerOnlyAliases: [...entry.observerOnlyAliases].sort(),
    observerEligible: entry.observerEligible,
    defaultSpecMapping: entry.defaultSpecMapping,
    specMappingByVariant: Object.fromEntries(Object.entries(entry.specMappingByVariant).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
  })).sort((left, right) => left.adapterProduct < right.adapterProduct ? -1 : left.adapterProduct > right.adapterProduct ? 1 : 0);
  return createHash('sha256').update(stableTestJson({ schemaVersion: 1, entries: canonicalEntries })).digest('hex');
}

describe('PR-001A1 ADAPTERS-derived registry strict resolution', () => {
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
    ambiguous.entries[0]!.aliases.push('IAG');
    ambiguous.registryDigest = computeProductRegistryDigest(ambiguous.entries);
    expect(() => resolveProductAdapterStrict('iag', { snapshot: ambiguous })).toThrow('AMBIGUOUS_PRODUCT');
    expect(() => resolveInjectedAdapterProductCode(ambiguous, 'iag')).toThrow('AMBIGUOUS_PRODUCT');
    const lowerProduct = structuredClone(getProductRegistrySnapshot()) as ProductRegistryView;
    lowerProduct.entries.find((entry) => entry.adapterProduct === 'IAG')!.adapterProduct = 'iag' as AdapterProductCode;
    lowerProduct.registryDigest = computeProductRegistryDigest(lowerProduct.entries);
    expect(resolveProductAdapterStrict('iag', { snapshot: lowerProduct }).adapterProduct).toBe('IAG');
    expect(resolveInjectedAdapterProductCode(lowerProduct, 'iag')).toBe('IAG');
    const drifted = structuredClone(getProductRegistrySnapshot()) as ProductRegistryView;
    drifted.registryDigest = '0'.repeat(64);
    expect(() => resolveProductAdapterStrict('IAG', { snapshot: drifted })).toThrow('REGISTRY_DRIFT');
    const malformed = { schemaVersion: 1, registryDigest: '0'.repeat(64), entries: null } as unknown as ProductRegistryView;
    expect(() => resolveProductAdapterStrict('IAG', { snapshot: malformed, registryDigest: '1'.repeat(64) })).toThrow('INVALID_REGISTRY');
    expect(() => resolveInjectedAdapterProductCode(null as unknown as ProductRegistryView, 'IAG')).toThrow('INVALID_REGISTRY');
    expect(() => resolveInjectedAdapterProductCode(malformed, 'IAG')).toThrow('INVALID_REGISTRY');
    const emptyProduct = structuredClone(getProductRegistrySnapshot()) as ProductRegistryView;
    emptyProduct.entries.find((entry) => entry.adapterProduct === 'IAG')!.adapterProduct = '' as AdapterProductCode;
    emptyProduct.registryDigest = digestWithEmptyAdapterProduct(emptyProduct.entries);
    expect(() => resolveProductAdapterStrict('IAG', { snapshot: emptyProduct })).toThrow('INVALID_REGISTRY');
    expect(() => resolveInjectedAdapterProductCode(emptyProduct, 'IAG')).toThrow('INVALID_REGISTRY');
    const trustedSnapshot = getProductRegistrySnapshot();
    const attackerSnapshot = structuredClone(trustedSnapshot) as ProductRegistryView;
    attackerSnapshot.entries[0]!.aliases.push('attacker-alias');
    attackerSnapshot.registryDigest = computeProductRegistryDigest(attackerSnapshot.entries);
    expect(() => resolveProductAdapterStrict({ product: 'attacker-alias', registry: attackerSnapshot }))
      .toThrow('REGISTRY_DRIFT');
    expect(resolveProductAdapterStrict({ product: 'IAG', registry: trustedSnapshot }).adapterProduct).toBe('IAG');
    expect(() => resolveProductAdapterStrict({ product: 'attacker-alias', registry: attackerSnapshot }, {
      snapshot: trustedSnapshot,
      registryDigest: trustedSnapshot.registryDigest,
    })).toThrow('REGISTRY_DRIFT');
    expect(() => resolveProductAdapterStrict({ product: 'IAG', registry: trustedSnapshot, snapshot: trustedSnapshot }))
      .toThrow('INVALID_REGISTRY');
    expect(() => resolveProductAdapterStrict({ product: 'IAG', registryDigest: '0'.repeat(64) }, {
      snapshot: trustedSnapshot,
      registryDigest: trustedSnapshot.registryDigest,
    })).toThrow('REGISTRY_DRIFT');
    expect(() => resolveProductAdapterStrict({ product: 'CC', productVariant: 'CYBER_COMMAND' }, {
      snapshot: trustedSnapshot,
      productVariant: 'ATHENA_XDR',
    })).toThrow('SPEC_IDENTITY_MISMATCH');
    expect(() => resolveProductAdapterStrict({ product: 'IAG', input: 'IAG' }))
      .toThrow('AMBIGUOUS_PRODUCT');
    expect(() => resolveProductAdapterStrict({ product: 'IAG', unknown: true } as StrictProductResolveRequest & { unknown: boolean }))
      .toThrow('INVALID_REGISTRY');
    expect(() => resolveProductAdapterStrict('IAG', {
      snapshot: trustedSnapshot,
      unknown: true,
    } as StrictProductResolveOptions & { unknown: boolean })).toThrow('INVALID_REGISTRY');
    const inheritedRequest = Object.create({
      product: 'IAG',
      registry: trustedSnapshot,
      registryDigest: trustedSnapshot.registryDigest,
      productVariant: 'ATHENA_XDR',
    }) as StrictProductResolveRequest;
    expect(() => resolveProductAdapterStrict(inheritedRequest)).toThrow('INVALID_REGISTRY');
    const inheritedOptions = Object.create({
      snapshot: trustedSnapshot,
      registryDigest: trustedSnapshot.registryDigest,
      productVariant: 'ATHENA_XDR',
    }) as StrictProductResolveOptions;
    expect(() => resolveProductAdapterStrict('CC', inheritedOptions)).toThrow('INVALID_REGISTRY');
    const accessorRequest = Object.create(null) as StrictProductResolveRequest;
    Object.defineProperty(accessorRequest, 'product', { enumerable: true, get: () => 'IAG' });
    expect(() => resolveProductAdapterStrict(accessorRequest)).toThrow('INVALID_REGISTRY');

    let productDigestReads = 0;
    const productTopLevelGetter = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(productTopLevelGetter, {
      schemaVersion: { enumerable: true, value: 1 },
      registryDigest: {
        enumerable: true,
        get: () => {
          productDigestReads += 1;
          return trustedSnapshot.registryDigest;
        },
      },
      entries: { enumerable: true, value: structuredClone(trustedSnapshot.entries) },
    });
    expect(() => resolveProductAdapterStrict('IAG', { snapshot: productTopLevelGetter as unknown as ProductRegistryView }))
      .toThrow('INVALID_REGISTRY');
    expect(productDigestReads).toBeLessThanOrEqual(1);

    let learningDigestReads = 0;
    const learningTopLevelGetter = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(learningTopLevelGetter, {
      schemaVersion: { enumerable: true, value: 1 },
      registryDigest: {
        enumerable: true,
        get: () => {
          learningDigestReads += 1;
          return trustedSnapshot.registryDigest;
        },
      },
      entries: { enumerable: true, value: structuredClone(trustedSnapshot.entries) },
    });
    expect(() => resolveInjectedAdapterProductCode(
      learningTopLevelGetter as unknown as ProductRegistryView,
      'IAG',
      { expectedRegistryDigest: trustedSnapshot.registryDigest },
    )).toThrow('INVALID_REGISTRY');
    expect(learningDigestReads).toBeLessThanOrEqual(1);

    const alternatingEntries = structuredClone(trustedSnapshot.entries) as ProductRegistryView['entries'];
    let entryReads = 0;
    Object.defineProperty(alternatingEntries, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        entryReads += 1;
        return entryReads === 1 ? { ...trustedSnapshot.entries[0], aliases: ['attacker-alias'] } : trustedSnapshot.entries[0];
      },
    });
    const alternatingView = {
      schemaVersion: 1 as const,
      registryDigest: trustedSnapshot.registryDigest,
      entries: alternatingEntries,
    } as ProductRegistryView;
    expect(() => resolveProductAdapterStrict('IAG', { snapshot: alternatingView })).toThrow('INVALID_REGISTRY');
    expect(() => resolveInjectedAdapterProductCode(alternatingView, 'IAG')).toThrow('INVALID_REGISTRY');
    expect(entryReads).toBeLessThanOrEqual(1);

    const inheritedEntry = Object.assign(
      Object.create({ aliases: ['attacker-alias'] }) as Record<string, unknown>,
      structuredClone(trustedSnapshot.entries[0]),
    );
    const inheritedEntryView = {
      schemaVersion: 1 as const,
      registryDigest: trustedSnapshot.registryDigest,
      entries: [inheritedEntry, ...structuredClone(trustedSnapshot.entries.slice(1))],
    } as ProductRegistryView;
    expect(() => resolveProductAdapterStrict('IAG', { snapshot: inheritedEntryView })).toThrow('INVALID_REGISTRY');
    expect(() => resolveInjectedAdapterProductCode(inheritedEntryView, 'IAG')).toThrow('INVALID_REGISTRY');

    const mappingGetterEntry = structuredClone(trustedSnapshot.entries[0]) as ProductRegistryView['entries'][number];
    let mappingReads = 0;
    Object.defineProperty(mappingGetterEntry, 'defaultSpecMapping', {
      configurable: true,
      enumerable: true,
      get: () => {
        mappingReads += 1;
        return { lookupCode: 'ATTACK', acceptedReturnedCodes: ['ATTACK'] };
      },
    });
    const mappingGetterView = {
      schemaVersion: 1 as const,
      registryDigest: trustedSnapshot.registryDigest,
      entries: [mappingGetterEntry, ...structuredClone(trustedSnapshot.entries.slice(1))],
    } as ProductRegistryView;
    expect(() => resolveProductAdapterStrict('IAG', { snapshot: mappingGetterView })).toThrow('INVALID_REGISTRY');
    expect(() => resolveInjectedAdapterProductCode(mappingGetterView, 'IAG')).toThrow('INVALID_REGISTRY');
    expect(mappingReads).toBeLessThanOrEqual(1);

    const prototypeMappingEntry = structuredClone(trustedSnapshot.entries[0]) as ProductRegistryView['entries'][number];
    prototypeMappingEntry.defaultSpecMapping = Object.create({
      lookupCode: 'ATTACK',
      acceptedReturnedCodes: ['ATTACK'],
    });
    const prototypeMappingView = {
      schemaVersion: 1 as const,
      registryDigest: trustedSnapshot.registryDigest,
      entries: [prototypeMappingEntry, ...structuredClone(trustedSnapshot.entries.slice(1))],
    } as ProductRegistryView;
    expect(() => resolveProductAdapterStrict('IAG', { snapshot: prototypeMappingView })).toThrow('INVALID_REGISTRY');
    expect(() => resolveInjectedAdapterProductCode(prototypeMappingView, 'IAG')).toThrow('INVALID_REGISTRY');
  });
});
