import { createHash } from 'node:crypto';
import type { FirmwareIdentity } from '@sangfor/version';

export type { FirmwareIdentity, FirmwareTruthRecord } from '@sangfor/version';

export type AdapterProductCode = string & { readonly __brand: 'AdapterProductCode' };

export interface SpecProductMapping {
  lookupCode: string;
  acceptedReturnedCodes: [string, ...string[]];
}

export interface ProductRegistryEntry {
  adapterProduct: AdapterProductCode;
  vendor: 'SANGFOR' | 'FORTINET' | 'CISCO';
  aliases: string[];
  observerOnlyAliases: string[];
  observerEligible: boolean;
  defaultSpecMapping: SpecProductMapping | null;
  specMappingByVariant: Record<string, SpecProductMapping>;
}

export interface ProductRegistryView {
  schemaVersion: 1;
  registryDigest: string;
  entries: ProductRegistryEntry[];
}

export type ProductRegistryErrorCode =
  | 'UNSUPPORTED_PRODUCT'
  | 'AMBIGUOUS_PRODUCT'
  | 'REGISTRY_DRIFT'
  | 'INVALID_REGISTRY'
  | 'SPEC_IDENTITY_MISMATCH'
  | 'VERSION_CONFLICT'
  | 'VERSION_TRUTH_UNAVAILABLE';

export class ProductRegistryError extends Error {
  readonly code: ProductRegistryErrorCode;

  constructor(code: ProductRegistryErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ProductRegistryError';
    this.code = code;
  }
}

export interface InjectedRegistryResolveOptions {
  expectedRegistryDigest?: string;
  productVariant?: string | null;
}

/** The plan's alias normalization: trim, lowercase, and normalize spaces/hyphens. */
export function normalizeRegistryAlias(value: string): string {
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function normalizeRegistryCode(value: string): string {
  return String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function normalizedMapping(mapping: SpecProductMapping | null): SpecProductMapping | null {
  if (mapping === null) return null;
  if (!mapping || typeof mapping !== 'object' || typeof mapping.lookupCode !== 'string' || !Array.isArray(mapping.acceptedReturnedCodes)) {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Spec mapping has invalid fields.');
  }
  if (mapping.lookupCode.trim() === '' || mapping.acceptedReturnedCodes.some((value) => typeof value !== 'string' || value.trim() === '')) {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Spec mapping contains an empty or non-string code.');
  }
  const accepted = [...new Set(mapping.acceptedReturnedCodes.map((value) => normalizeRegistryCode(value)))].sort();
  if (!mapping.lookupCode || accepted.length === 0) {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Spec mapping must have a lookup code and accepted return code.');
  }
  return {
    lookupCode: normalizeRegistryCode(mapping.lookupCode),
    acceptedReturnedCodes: accepted as [string, ...string[]],
  };
}

function normalizedEntry(entry: ProductRegistryEntry): ProductRegistryEntry {
  if (!entry || typeof entry !== 'object') {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Registry entry must be an object.');
  }
  if (!Array.isArray(entry.aliases) || !Array.isArray(entry.observerOnlyAliases)
    || !entry.specMappingByVariant || typeof entry.specMappingByVariant !== 'object' || Array.isArray(entry.specMappingByVariant)) {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Registry identity has invalid collection fields.');
  }
  if (!['SANGFOR', 'FORTINET', 'CISCO'].includes(entry.vendor)) {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Registry identity has an invalid vendor.');
  }
  if (typeof entry.adapterProduct !== 'string'
    || entry.aliases.some((value) => typeof value !== 'string')
    || entry.observerOnlyAliases.some((value) => typeof value !== 'string')
    || entry.aliases.some((value) => normalizeRegistryAlias(value) === '')
    || entry.observerOnlyAliases.some((value) => normalizeRegistryAlias(value) === '')) {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Registry identity contains a non-string code or alias.');
  }
  if (typeof entry.observerEligible !== 'boolean') {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Registry identity has an invalid observer eligibility flag.');
  }
  const aliases = [...new Set(entry.aliases.map((value) => normalizeRegistryAlias(value)).filter(Boolean))].sort();
  const observerOnlyAliases = [...new Set(entry.observerOnlyAliases.map((value) => normalizeRegistryAlias(value)).filter(Boolean))].sort();
  if (Object.values(entry.specMappingByVariant).some((mapping) => !mapping || typeof mapping !== 'object')) {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Variant Spec mapping must be an object.');
  }
  if (Object.keys(entry.specMappingByVariant).some((rawKey) => normalizeRegistryCode(rawKey) === '')) {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Variant Spec mapping has an empty key.');
  }
  const variants = Object.fromEntries(
    Object.keys(entry.specMappingByVariant)
      .map((rawKey) => ({ key: normalizeRegistryCode(rawKey), mapping: entry.specMappingByVariant[rawKey]! }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ key, mapping }) => [key, normalizedMapping(mapping)])
  ) as Record<string, SpecProductMapping>;
  const adapterProduct = normalizeRegistryCode(entry.adapterProduct);
  const observerOnlySet = new Set(observerOnlyAliases);
  if (!adapterProduct) {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Registry identity has invalid required fields.');
  }
  if (observerOnlyAliases.some((alias) => !aliases.includes(alias))) {
    throw new ProductRegistryError('INVALID_REGISTRY', `${adapterProduct} has an observer-only alias outside aliases.`);
  }
  if (observerOnlySet.size !== observerOnlyAliases.length) {
    throw new ProductRegistryError('INVALID_REGISTRY', `${adapterProduct} contains duplicate observer aliases.`);
  }
  return {
    adapterProduct: adapterProduct as AdapterProductCode,
    vendor: entry.vendor,
    aliases,
    observerOnlyAliases,
    observerEligible: entry.observerEligible,
    defaultSpecMapping: normalizedMapping(entry.defaultSpecMapping),
    specMappingByVariant: variants,
  };
}

/**
 * Digest only canonical identity data. Product/alias/variant/spec codes and
 * accepted return codes are normalized, sorted, and deduplicated first.
 */
export function computeProductRegistryDigest(entries: readonly ProductRegistryEntry[]): string {
  const canonicalEntries = entries
    .map((entry) => normalizedEntry(entry))
    .sort((a, b) => a.adapterProduct.localeCompare(b.adapterProduct))
    .map((entry) => ({
      adapterProduct: entry.adapterProduct,
      vendor: entry.vendor,
      aliases: entry.aliases,
      observerOnlyAliases: entry.observerOnlyAliases,
      observerEligible: entry.observerEligible,
      defaultSpecMapping: entry.defaultSpecMapping,
      specMappingByVariant: entry.specMappingByVariant,
    }));
  return createHash('sha256').update(stableJson({ schemaVersion: 1, entries: canonicalEntries })).digest('hex');
}

export function createProductRegistryView(entries: readonly ProductRegistryEntry[]): ProductRegistryView {
  const normalizedEntries = entries.map((entry) => normalizedEntry(entry));
  const view: ProductRegistryView = {
    schemaVersion: 1,
    registryDigest: computeProductRegistryDigest(normalizedEntries),
    entries: normalizedEntries,
  };
  validateProductRegistryView(view);
  return deepFreeze(view);
}

export function validateProductRegistryView(view: ProductRegistryView): ProductRegistryView {
  if (!view || typeof view !== 'object' || view.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(view.registryDigest)) {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Registry view schema or digest is invalid.');
  }
  if (!Array.isArray(view.entries) || view.entries.length === 0) {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Registry view must contain entries.');
  }
  const normalizedEntries = view.entries.map((entry) => normalizedEntry(entry));
  const products = new Set(normalizedEntries.map((entry) => entry.adapterProduct));
  if (products.size !== normalizedEntries.length) {
    throw new ProductRegistryError('INVALID_REGISTRY', 'Registry contains duplicate product codes.');
  }
  const expectedDigest = computeProductRegistryDigest(normalizedEntries);
  if (expectedDigest !== view.registryDigest) {
    throw new ProductRegistryError('REGISTRY_DRIFT', 'Registry digest does not match canonical identity data.');
  }
  return view;
}

export function resolveInjectedAdapterProductCode(
  view: ProductRegistryView,
  product: string,
  options: InjectedRegistryResolveOptions = {},
): AdapterProductCode {
  if (typeof product !== 'string') throw new ProductRegistryError('UNSUPPORTED_PRODUCT', 'Product identity must be a string.');
  if (options.expectedRegistryDigest && options.expectedRegistryDigest !== view.registryDigest) {
    throw new ProductRegistryError('REGISTRY_DRIFT', 'Injected registry digest differs from the expected digest.');
  }
  validateProductRegistryView(view);
  const normalized = normalizeRegistryAlias(product);
  const matches = view.entries.filter((entry) => (
    normalizeRegistryAlias(entry.adapterProduct) === normalized || entry.aliases.includes(normalized)
  ));
  if (matches.length === 0) throw new ProductRegistryError('UNSUPPORTED_PRODUCT', `No identity matches ${String(product)}.`);
  if (matches.length > 1) throw new ProductRegistryError('AMBIGUOUS_PRODUCT', `Multiple identities match ${String(product)}.`);
  const match = matches[0]!;
  if (!match.observerEligible) throw new ProductRegistryError('UNSUPPORTED_PRODUCT', `${match.adapterProduct} is not observer eligible.`);
  if (options.productVariant !== undefined && options.productVariant !== null) {
    const variant = normalizeRegistryCode(options.productVariant);
    if (!Object.prototype.hasOwnProperty.call(match.specMappingByVariant, variant)) {
      throw new ProductRegistryError('SPEC_IDENTITY_MISMATCH', `${match.adapterProduct} has no mapping for ${variant}.`);
    }
  }
  return match.adapterProduct;
}

export interface ResolvedFirmwareIdentity extends Omit<FirmwareIdentity, 'adapterProduct'> {
  adapterProduct: AdapterProductCode;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
