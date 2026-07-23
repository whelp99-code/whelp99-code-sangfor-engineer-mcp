import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeProductRegistryDigest,
  isFirmwareTruthEligible,
  resolveInjectedAdapterProductCode,
  resolveVerifiedFirmwareIdentity,
  transitionFirmwareTruthStatus,
  type AdapterProductCode,
} from '../packages/sangfor-learning-strategy/src/index.js';
import {
  getProductRegistrySnapshot,
  listProductAdapters,
  normalizeAutomationProduct,
  resolveProductAdapterStrict,
  type ProductRegistryView,
} from '../packages/sangfor-product-adapters/src/index.js';
import * as productAdapterRuntime from '../packages/sangfor-product-adapters/src/index.js';
import {
  canonicalizeFingerprintDescriptors,
  fingerprintFromDescriptors,
  loadFirmwareTruthRecords,
  parseFirmwareTruthRecord,
  sameFirmwareIdentity,
  toFirmwareIdentity,
  type FirmwareTruthRecord,
} from '../packages/sangfor-version/src/index.js';

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
    expect(() => resolveInjectedAdapterProductCode(getProductRegistrySnapshot(), 'NDR', {
      productVariant: ['CYBER_COMMAND'] as unknown as string,
    })).toThrow('SPEC_IDENTITY_MISMATCH');
  });

  it('keeps package edges explicit and prevents learning/version from importing product adapters', () => {
    const manifest = JSON.parse(readFileSync(new URL('../packages/sangfor-product-adapters/package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toMatchObject({
      '@sangfor/approval': 'workspace:*',
      '@sangfor/operator': 'workspace:*',
      '@sangfor/shared': 'workspace:*',
      '@sangfor/learning-strategy': 'workspace:*',
    });
    const productSource = readFileSync(new URL('../packages/sangfor-product-adapters/src/index.ts', import.meta.url), 'utf8');
    expect(productSource).toContain("import type {");
    expect(productSource).toContain("from '@sangfor/learning-strategy';");
    expect(readFileSync(new URL('../packages/sangfor-learning-strategy/src/index.ts', import.meta.url), 'utf8'))
      .not.toContain('@sangfor/product-adapters');
    expect(readFileSync(new URL('../packages/sangfor-version/src/index.ts', import.meta.url), 'utf8'))
      .not.toContain('@sangfor/product-adapters');
  });

  it('loads conflict seeds without making CC versions eligible for Spec input', () => {
    const records = loadFirmwareTruthRecords();
    const cc = records.filter((record) => record.adapterProduct === 'NDR');
    expect(cc.map((record) => record.versionRaw)).toEqual(['3.0.98', '3.0.98C']);
    expect(cc.every((record) => record.status === 'conflict')).toBe(true);
    expect(cc.every((record) => !isFirmwareTruthEligible(record))).toBe(true);
  });

  it('strictly parses truth records, fingerprints allowlisted descriptors, and preserves identity equality', () => {
    const record = parseFirmwareTruthRecord({
      id: 'iag-13.0.120-candidate',
      vendor: 'SANGFOR',
      adapterProduct: 'IAG',
      productVariant: null,
      versionRaw: '13.0.120',
      versionFamily: '13.0',
      revision: 'R1',
      buildId: 'build-7',
      hotfix: 'HF-2',
      uiFingerprint: 'a'.repeat(64),
      apiFingerprint: 'b'.repeat(64),
      status: 'candidate',
      observedAt: '2026-07-23T00:00:00.000Z',
      evidenceFile: 'evidence.json',
      specVersion: '13.0.120',
      specApplicability: 'unreviewed',
      source: 'test fixture',
    });
    expect(record.versionRaw).toBe('13.0.120');
    expect(() => parseFirmwareTruthRecord({ ...record, unexpected: true })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, vendor: 'UNKNOWN' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, status: 'published' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, specApplicability: 'approved' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, observedAt: 'not-a-timestamp' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, observedAt: '2026-02-30T10:41:30.863Z' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, uiFingerprint: 'not-a-hash' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, productVariant: '' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, evidenceFile: '/etc/hosts' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, evidenceFile: '../evidence.json' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, evidenceFile: null })).not.toThrow();
    expect(() => parseFirmwareTruthRecord({ ...record, status: 'verified', specApplicability: 'verified', evidenceFile: null })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => parseFirmwareTruthRecord({ ...record, source: undefined })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(sameFirmwareIdentity(record, { ...record, id: 'iag-13.0.120-other' })).toBe(true);
    expect(sameFirmwareIdentity(record, { ...record, versionRaw: '13.0.120R1' })).toBe(false);
    expect(sameFirmwareIdentity(record, { ...record, revision: 'R2' })).toBe(false);
    expect(sameFirmwareIdentity(record, { ...record, buildId: 'build-8' })).toBe(false);
    expect(sameFirmwareIdentity(record, { ...record, hotfix: 'HF-3' })).toBe(false);
    expect(sameFirmwareIdentity(record, { ...record, uiFingerprint: 'c'.repeat(64) })).toBe(false);
    expect(sameFirmwareIdentity(record, { ...record, apiFingerprint: 'd'.repeat(64) })).toBe(false);

    const descriptor = {
      buildId: 'build-7',
      assetManifestId: 'assets-1',
      framework: { name: 'vue', version: '3.5.0' },
      routeSignature: ['https://host-a/dashboard?token=alpha&customer=acme#x', 'system'],
      apiSchemaSignature: 'api-schema',
      hostname: '10.0.0.1',
      origin: 'https://device.example.test',
      serial: 'SERIAL-123',
      license: 'LICENSE-123',
      customer: 'customer-123',
      user: 'admin',
      token: 'must-not-be-included',
      observedAt: '2026-07-23T00:00:00.000Z',
    };
    const reordered = {
      routeSignature: ['https://host-b/dashboard?token=beta&customer=other#different', ' system '],
      framework: { ignored: 'nested-secret', version: '3.5.0', name: 'vue', token: 'nested-token' },
      frameworkVersion: '3.5.0',
      rawBuildId: 'build-7',
      apiSchemaSignature: 'api-schema',
      assetManifestId: 'assets-1',
      time: '2026-07-23T00:00:00.000Z',
    };
    const canonical = canonicalizeFingerprintDescriptors(descriptor);
    const canonicalValue = JSON.parse(canonical) as Record<string, unknown>;
    expect(canonical).not.toContain('build-7');
    expect(canonical).not.toContain('assets-1');
    expect(canonical).not.toContain('api-schema');
    expect(canonical).not.toContain('dashboard');
    expect(canonical).not.toContain('system');
    for (const secret of ['10.0.0.1', 'https://device.example.test', 'host-a', 'host-b', 'alpha', 'beta', 'acme', 'other', 'SERIAL-123', 'LICENSE-123', 'customer-123', 'admin', 'must-not-be-included']) {
      expect(canonical).not.toContain(secret);
    }
    expect(canonicalValue.buildId).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalValue.assetManifestId).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalValue.apiSchemaSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalValue.routeSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(canonicalValue.framework as Record<string, unknown>)).toEqual(['name', 'version']);
    expect((canonicalValue.framework as Record<string, unknown>).name).toMatch(/^[a-f0-9]{64}$/);
    expect((canonicalValue.framework as Record<string, unknown>).version).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalValue.buildId).not.toBe(canonicalValue.assetManifestId);
    expect(canonicalizeFingerprintDescriptors(reordered)).toBe(canonical);
    const hashDashboard = canonicalizeFingerprintDescriptors({
      routeSignature: ['https://host-a/index.html#/dashboard?token=alpha&customer=acme#secondary'],
    });
    const hashDashboardOtherOrigin = canonicalizeFingerprintDescriptors({
      routeSignature: ['https://host-b/index.html#/dashboard?token=beta&customer=other#different'],
    });
    const hashSystem = canonicalizeFingerprintDescriptors({
      routeSignature: ['https://host-a/index.html#/system?token=alpha&customer=acme#secondary'],
    });
    expect(hashDashboardOtherOrigin).toBe(hashDashboard);
    expect(hashSystem).not.toBe(hashDashboard);
    for (const route of ['#/dashboard', '/#/dashboard', '#!/dashboard', 'index.html#/dashboard']) {
      expect(canonicalizeFingerprintDescriptors({ routeSignature: [route] })).toBe(hashDashboard);
    }
    for (const secret of ['host-a', 'host-b', 'alpha', 'beta', 'acme', 'other', 'secondary', 'different']) {
      expect(hashDashboard).not.toContain(secret);
    }
    expect(canonicalizeFingerprintDescriptors({ routeSignature: ['/customers/:customerId'] }))
      .toBe(canonicalizeFingerprintDescriptors({ routeSignature: ['/customers/{customerId}'] }));
    for (const route of [
      '/customers/acme', '/token/alpha', '/users/admin', '/devices/SERIAL123',
      '/reports/123', '/reports/550e8400-e29b-41d4-a716-446655440000',
      '/reports/abcdefabcdefabcdef', '/reports/192.168.1.1', '/reports/admin@example.com',
    ]) {
      expect(() => canonicalizeFingerprintDescriptors({ routeSignature: [route] })).toThrow('INVALID_FIRMWARE_TRUTH');
    }
    const nestedFrameworkVersion = canonicalizeFingerprintDescriptors({
      buildId: 'build-7',
      framework: { name: 'vue', version: '3.5.0' },
    });
    const topLevelFrameworkVersion = canonicalizeFingerprintDescriptors({
      buildId: 'build-7',
      framework: { name: 'vue' },
      frameworkVersion: '3.5.0',
    });
    expect(topLevelFrameworkVersion).toBe(nestedFrameworkVersion);
    expect(fingerprintFromDescriptors({ buildId: 'build-7', framework: { name: 'vue', version: '3.5.0' } }))
      .toBe(fingerprintFromDescriptors({ buildId: 'build-7', framework: { name: 'vue' }, frameworkVersion: '3.5.0' }));
    expect(() => canonicalizeFingerprintDescriptors({
      buildId: 'build-7',
      framework: { name: 'vue', version: '3.5.0' },
      frameworkVersion: '3.5.1',
    })).toThrow('INVALID_FIRMWARE_TRUTH');
    const fingerprint = fingerprintFromDescriptors(descriptor);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const secret of ['build-7', 'assets-1', 'api-schema', 'dashboard', 'system', '10.0.0.1', 'host-a', 'host-b', 'alpha', 'beta', 'acme', 'other', 'SERIAL-123', 'LICENSE-123', 'customer-123', 'admin', 'must-not-be-included']) {
      expect(fingerprint).not.toContain(secret);
    }
    expect(fingerprintFromDescriptors(reordered)).toBe(fingerprint);
    expect(() => canonicalizeFingerprintDescriptors({})).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors(null)).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors([])).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ hostname: '10.0.0.1', token: 'only-secret' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ buildId: 123 })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ framework: 'vue' })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: ['ok', 7] })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: [] })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: ['https://user:pass@host-a/dashboard'] })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: ['https://[invalid/dashboard'] })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: ['https://host-a/%ZZ'] })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: ['dashboard\u0000'] })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ buildId: 'x'.repeat(257) })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: Array.from({ length: 65 }, () => 'route') })).toThrow('INVALID_FIRMWARE_TRUTH');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeFingerprintDescriptors(cyclic)).toThrow('INVALID_FIRMWARE_TRUTH');
    const cyclicRoutes: unknown[] = [];
    cyclicRoutes.push(cyclicRoutes);
    expect(() => canonicalizeFingerprintDescriptors({ routeSignature: cyclicRoutes })).toThrow('INVALID_FIRMWARE_TRUTH');
  });

  it('allows only forward truth-state transitions and requires confined regular evidence for verified eligibility', () => {
    const root = join(tmpdir(), `learning-version-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const outsideRoot = `${root}-outside`;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'evidence.json'), '{"ok":true}\n');
    mkdirSync(join(root, 'directory'), { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(join(outsideRoot, 'outside.json'), '{"outside":true}\n');
    symlinkSync(join(outsideRoot, 'outside.json'), join(root, 'symlink.json'));
    const candidate: FirmwareTruthRecord = parseFirmwareTruthRecord({
      id: 'fixture-candidate',
      vendor: 'FORTINET',
      adapterProduct: 'FORTIOS',
      productVariant: null,
      versionRaw: '8.0.0',
      versionFamily: '8.0',
      revision: null,
      buildId: 'forti-build',
      hotfix: null,
      uiFingerprint: null,
      apiFingerprint: null,
      status: 'candidate',
      observedAt: '2026-07-23T00:00:00.000Z',
      evidenceFile: 'evidence.json',
      specVersion: '8.0.0',
      specApplicability: 'unreviewed',
      source: 'test fixture',
    });
    const conflict = transitionFirmwareTruthStatus(candidate, 'conflict');
    expect(() => transitionFirmwareTruthStatus(conflict, 'candidate')).toThrow('INVALID_VERSION_TRUTH_TRANSITION');
    const superseded = transitionFirmwareTruthStatus(conflict, 'superseded');
    expect(() => transitionFirmwareTruthStatus(superseded, 'verified')).toThrow('INVALID_VERSION_TRUTH_TRANSITION');

    const verified = transitionFirmwareTruthStatus(candidate, 'verified', { specApplicability: 'verified' });
    expect(isFirmwareTruthEligible(verified)).toBe(false);
    expect(isFirmwareTruthEligible(verified, { evidenceRoot: root })).toBe(true);
    for (const evidenceFile of ['', '/etc/hosts', 'C:\\outside.json', '../evidence.json', 'foo/../../evidence.json', 'missing.json', 'directory', 'symlink.json']) {
      expect(isFirmwareTruthEligible({ ...verified, evidenceFile }, { evidenceRoot: root })).toBe(false);
    }
    expect(toFirmwareIdentity(verified)).toMatchObject({ adapterProduct: 'FORTIOS', buildId: 'forti-build', specVersion: '8.0.0' });
    expect(resolveVerifiedFirmwareIdentity(verified, getProductRegistrySnapshot(), { evidenceRoot: root }).adapterProduct).toBe('FORTIOS');
    expect(() => resolveVerifiedFirmwareIdentity(null as unknown as FirmwareTruthRecord, getProductRegistrySnapshot(), { evidenceRoot: root })).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(() => resolveVerifiedFirmwareIdentity({ status: 'conflict' } as unknown as FirmwareTruthRecord, getProductRegistrySnapshot(), { evidenceRoot: root })).toThrow('INVALID_FIRMWARE_TRUTH');
  });
});

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}
