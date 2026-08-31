import { createHash } from 'node:crypto';
import type { AdapterProductCode, ProductRegistryEntry, SpecProductMapping } from '@sangfor/learning-strategy';
import type { AdapterIdentity } from './types.js';
import {
  assertPlainRecord,
  denseDataArray,
  denseStringArray,
  exactOwnDataRecord,
  ownStringKeys,
  readOwnDataProperty,
} from './registry-object.js';

export function normalizeIdentityAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function normalizeIdentityCode(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.max(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftCode = leftPoints[index]?.codePointAt(0) ?? -1;
    const rightCode = rightPoints[index]?.codePointAt(0) ?? -1;
    if (leftCode < rightCode) return -1;
    if (leftCode > rightCode) return 1;
  }
  return 0;
}

export function stableRegistryJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableRegistryJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${stableRegistryJson(record[key])}`).join(',')}}`;
}

const REGISTRY_ENTRY_KEYS = [
  'adapterProduct', 'vendor', 'aliases', 'observerOnlyAliases', 'observerEligible',
  'defaultSpecMapping', 'specMappingByVariant',
] as const;
const SPEC_MAPPING_KEYS = ['lookupCode', 'acceptedReturnedCodes'] as const;
const REGISTRY_VIEW_KEYS = ['schemaVersion', 'registryDigest', 'entries'] as const;

export function canonicalSpecMapping(mapping: unknown, label = 'Spec mapping'): SpecProductMapping | null {
  if (mapping === null) return null;
  const fields = exactOwnDataRecord(mapping, SPEC_MAPPING_KEYS, label);
  const lookupCode = fields.lookupCode;
  const acceptedReturnedCodes = denseStringArray(fields.acceptedReturnedCodes, `${label}.acceptedReturnedCodes`);
  if (typeof lookupCode !== 'string' || lookupCode.trim() === '' || acceptedReturnedCodes.some((code) => code.trim() === '')) {
    throw new Error(`INVALID_REGISTRY: ${label} has invalid fields.`);
  }
  const accepted = [...new Set(acceptedReturnedCodes.map((code) => normalizeIdentityCode(code)))].sort(compareCodePoints);
  if (accepted.length === 0 || normalizeIdentityCode(lookupCode) === '') {
    throw new Error(`INVALID_REGISTRY: ${label} must have a lookup code and accepted return code.`);
  }
  return {
    lookupCode: normalizeIdentityCode(lookupCode),
    acceptedReturnedCodes: accepted as [string, ...string[]],
  };
}

export function canonicalVariantMappings(value: unknown, label: string): Record<string, SpecProductMapping> {
  assertPlainRecord(value, label);
  const variantEntries = ownStringKeys(value, label).map((rawVariant) => ({
    variant: normalizeIdentityCode(rawVariant),
    mapping: canonicalSpecMapping(readOwnDataProperty(value, rawVariant, label), `${label}.${rawVariant}`),
  }));
  if (variantEntries.some(({ variant, mapping }) => variant === '' || mapping === null)) {
    throw new Error(`INVALID_REGISTRY: ${label} contains an empty variant key.`);
  }
  if (new Set(variantEntries.map(({ variant }) => variant)).size !== variantEntries.length) {
    throw new Error('INVALID_REGISTRY: variant keys collide after canonical normalization.');
  }
  const specMappingByVariant = Object.fromEntries(
    variantEntries
      .sort((a, b) => compareCodePoints(a.variant, b.variant))
      .map(({ variant, mapping }) => [variant, mapping])
  ) as Record<string, SpecProductMapping>;
  return specMappingByVariant;
}

export function canonicalRegistryEntry(entry: unknown): ProductRegistryEntry {
  const fields = exactOwnDataRecord(entry, REGISTRY_ENTRY_KEYS, 'Registry entry');
  const adapterProduct = fields.adapterProduct;
  const vendor = fields.vendor;
  const aliases = denseStringArray(fields.aliases, 'Registry entry.aliases');
  const observerOnlyAliases = denseStringArray(fields.observerOnlyAliases, 'Registry entry.observerOnlyAliases');
  const observerEligible = fields.observerEligible;
  if (typeof adapterProduct !== 'string' || normalizeIdentityCode(adapterProduct) === ''
    || typeof vendor !== 'string' || !['SANGFOR', 'FORTINET', 'CISCO'].includes(vendor)
    || typeof observerEligible !== 'boolean'
    || aliases.some((alias) => normalizeIdentityAlias(alias) === '')
    || observerOnlyAliases.some((alias) => normalizeIdentityAlias(alias) === '')) {
    throw new Error('INVALID_REGISTRY: identity fields are invalid.');
  }
  const normalizedAliases = [...new Set(aliases.map((alias) => normalizeIdentityAlias(alias)))].sort(compareCodePoints);
  const normalizedObserverOnlyAliases = [...new Set(observerOnlyAliases.map((alias) => normalizeIdentityAlias(alias)))].sort(compareCodePoints);
  return {
    adapterProduct: normalizeIdentityCode(adapterProduct) as AdapterProductCode,
    vendor: vendor as 'SANGFOR' | 'FORTINET' | 'CISCO',
    aliases: normalizedAliases,
    observerOnlyAliases: normalizedObserverOnlyAliases,
    observerEligible,
    defaultSpecMapping: canonicalSpecMapping(fields.defaultSpecMapping, 'Registry entry.defaultSpecMapping'),
    specMappingByVariant: canonicalVariantMappings(fields.specMappingByVariant, 'Registry entry.specMappingByVariant'),
  };
}

export function canonicalRegistryEntries(value: unknown): ProductRegistryEntry[] {
  const rawEntries = denseDataArray(value, 'Registry snapshot.entries');
  if (rawEntries.length === 0) throw new Error('INVALID_REGISTRY: registry snapshot must contain entries.');
  const canonicalEntries = rawEntries
    .map((entry) => canonicalRegistryEntry(entry))
    .sort((a, b) => compareCodePoints(a.adapterProduct, b.adapterProduct));
  const products = new Set<string>();
  for (const entry of canonicalEntries) {
    if (products.has(entry.adapterProduct)) throw new Error('INVALID_REGISTRY: duplicate adapter product.');
    products.add(entry.adapterProduct);
    if (entry.observerOnlyAliases.some((alias) => !entry.aliases.includes(alias))) {
      throw new Error('INVALID_REGISTRY: observer-only alias is not in aliases.');
    }
  }
  return deepFreeze(canonicalEntries);
}

export function productRegistryDigestFromCanonicalEntries(canonicalEntries: readonly ProductRegistryEntry[]): string {
  const digestEntries = canonicalEntries
    .map((entry) => ({
      adapterProduct: entry.adapterProduct,
      vendor: entry.vendor,
      aliases: entry.aliases,
      observerOnlyAliases: entry.observerOnlyAliases,
      observerEligible: entry.observerEligible,
      defaultSpecMapping: entry.defaultSpecMapping,
      specMappingByVariant: entry.specMappingByVariant,
    }));
  return createHash('sha256').update(stableRegistryJson({ schemaVersion: 1, entries: digestEntries })).digest('hex');
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function cloneRequiredSpecMapping(mapping: SpecProductMapping): SpecProductMapping {
  return {
    lookupCode: mapping.lookupCode,
    acceptedReturnedCodes: [...mapping.acceptedReturnedCodes] as [string, ...string[]],
  };
}

export function cloneSpecMapping(mapping: SpecProductMapping | null): SpecProductMapping | null {
  return mapping === null ? null : cloneRequiredSpecMapping(mapping);
}

export function cloneAdapterIdentity(identity: AdapterIdentity): AdapterIdentity {
  return {
    adapterProduct: identity.adapterProduct,
    vendor: identity.vendor,
    aliases: [...identity.aliases],
    observerOnlyAliases: [...identity.observerOnlyAliases],
    observerEligible: identity.observerEligible,
    defaultSpecMapping: cloneSpecMapping(identity.defaultSpecMapping),
    specMappingByVariant: Object.fromEntries(
      Object.entries(identity.specMappingByVariant).map(([key, mapping]) => [key, cloneRequiredSpecMapping(mapping)]),
    ),
  };
}

export function validateStrictSnapshot(snapshot: unknown): {
  registryDigest: string;
  canonicalEntries: ProductRegistryEntry[];
} {
  const fields = exactOwnDataRecord(snapshot, REGISTRY_VIEW_KEYS, 'Registry snapshot');
  const schemaVersion = fields.schemaVersion;
  const registryDigest = fields.registryDigest;
  const rawEntries = fields.entries;
  if (schemaVersion !== 1 || typeof registryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(registryDigest)
    || !Array.isArray(rawEntries)) {
    throw new Error('INVALID_REGISTRY: snapshot shape is invalid.');
  }
  const canonicalEntries = canonicalRegistryEntries(rawEntries);
  if (productRegistryDigestFromCanonicalEntries(canonicalEntries) !== registryDigest) {
    throw new Error('REGISTRY_DRIFT: snapshot digest does not match identity data.');
  }
  return {
    registryDigest,
    canonicalEntries,
  };
}
