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

function compareCodePoints(left: string, right: string): number {
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

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

const REGISTRY_ENTRY_KEYS = [
  'adapterProduct', 'vendor', 'aliases', 'observerOnlyAliases', 'observerEligible',
  'defaultSpecMapping', 'specMappingByVariant',
] as const;
const SPEC_MAPPING_KEYS = ['lookupCode', 'acceptedReturnedCodes'] as const;
const REGISTRY_VIEW_KEYS = ['schemaVersion', 'registryDigest', 'entries'] as const;
const RESOLVE_OPTION_KEYS = ['expectedRegistryDigest', 'productVariant'] as const;

function invalidRegistry(message: string): never {
  throw new ProductRegistryError('INVALID_REGISTRY', message);
}

function isPlainRecord(value: unknown): value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function assertPlainRecord(value: unknown, label: string): asserts value is object {
  if (!isPlainRecord(value)) invalidRegistry(`${label} must be a plain object.`);
}

function hasOwnProperty(value: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    invalidRegistry('Object property inspection failed.');
  }
}

function readOwnDataProperty(value: object, key: string, label: string): unknown {
  if (!hasOwnProperty(value, key)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      invalidRegistry(`${label}.${key} must be an own data property.`);
    }
    return descriptor.value;
  } catch (error) {
    if (error instanceof ProductRegistryError) throw error;
    invalidRegistry(`${label}.${key} could not be read safely.`);
  }
}

function ownStringKeys(value: object, label: string): string[] {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    invalidRegistry(`${label} keys could not be inspected safely.`);
  }
  if (keys.some((key) => typeof key !== 'string')) invalidRegistry(`${label} contains a symbol key.`);
  return keys as string[];
}

function exactOwnDataRecord(value: unknown, expectedKeys: readonly string[], label: string): Record<string, unknown> {
  assertPlainRecord(value, label);
  const keys = ownStringKeys(value, label);
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    invalidRegistry(`${label} contains missing or unknown keys.`);
  }
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) fields[key] = readOwnDataProperty(value, key, label);
  return fields;
}

function optionalOwnDataRecord(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  assertPlainRecord(value, label);
  const keys = ownStringKeys(value, label);
  if (keys.some((key) => !allowedKeys.includes(key))) invalidRegistry(`${label} contains an unknown key.`);
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of keys) fields[key] = readOwnDataProperty(value, key, label);
  return fields;
}

function denseDataArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalidRegistry(`${label} must be an array.`);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype && prototype !== null) invalidRegistry(`${label} must have a plain array prototype.`);
  } catch (error) {
    if (error instanceof ProductRegistryError) throw error;
    invalidRegistry(`${label} could not be inspected safely.`);
  }
  const length = readOwnDataProperty(value, 'length', label);
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    invalidRegistry(`${label} has an invalid length.`);
  }
  const keys = ownStringKeys(value, label);
  for (const key of keys) {
    if (key === 'length') continue;
    if (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length) {
      invalidRegistry(`${label} must contain dense numeric indices only.`);
    }
  }
  if (keys.length !== length + 1) invalidRegistry(`${label} contains a hole.`);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!hasOwnProperty(value, key)) invalidRegistry(`${label} contains a hole.`);
    result.push(readOwnDataProperty(value, key, `${label}[${index}]`));
  }
  return result;
}

function denseStringArray(value: unknown, label: string): string[] {
  const items = denseDataArray(value, label);
  if (items.some((item) => typeof item !== 'string')) invalidRegistry(`${label} must contain only strings.`);
  return items as string[];
}

function normalizedMapping(mapping: unknown, label = 'Spec mapping'): SpecProductMapping | null {
  if (mapping === null) return null;
  const fields = exactOwnDataRecord(mapping, SPEC_MAPPING_KEYS, label);
  const lookupCode = fields.lookupCode;
  const acceptedReturnedCodes = denseStringArray(fields.acceptedReturnedCodes, `${label}.acceptedReturnedCodes`);
  if (typeof lookupCode !== 'string' || lookupCode.trim() === '' || acceptedReturnedCodes.some((value) => value.trim() === '')) {
    invalidRegistry(`${label} contains an empty or non-string code.`);
  }
  const accepted = [...new Set(acceptedReturnedCodes.map((value) => normalizeRegistryCode(value)))].sort(compareCodePoints);
  if (accepted.length === 0 || normalizeRegistryCode(lookupCode) === '') {
    invalidRegistry(`${label} must have a lookup code and accepted return code.`);
  }
  return {
    lookupCode: normalizeRegistryCode(lookupCode),
    acceptedReturnedCodes: accepted as [string, ...string[]],
  };
}

function normalizedEntry(entry: unknown): ProductRegistryEntry {
  const fields = exactOwnDataRecord(entry, REGISTRY_ENTRY_KEYS, 'Registry entry');
  const adapterProduct = fields.adapterProduct;
  const vendor = fields.vendor;
  const aliases = denseStringArray(fields.aliases, 'Registry entry.aliases');
  const observerOnlyAliases = denseStringArray(fields.observerOnlyAliases, 'Registry entry.observerOnlyAliases');
  const observerEligible = fields.observerEligible;
  if (typeof adapterProduct !== 'string' || typeof vendor !== 'string' || !['SANGFOR', 'FORTINET', 'CISCO'].includes(vendor)) {
    invalidRegistry('Registry identity has an invalid product or vendor.');
  }
  if (typeof observerEligible !== 'boolean') invalidRegistry('Registry identity has an invalid observer eligibility flag.');
  if (aliases.some((value) => normalizeRegistryAlias(value) === '')
    || observerOnlyAliases.some((value) => normalizeRegistryAlias(value) === '')) {
    invalidRegistry('Registry identity contains an empty alias.');
  }
  const normalizedAliases = [...new Set(aliases.map((value) => normalizeRegistryAlias(value)))].sort(compareCodePoints);
  const normalizedObserverOnlyAliases = [...new Set(observerOnlyAliases.map((value) => normalizeRegistryAlias(value)))].sort(compareCodePoints);
  const rawVariantMappings = fields.specMappingByVariant;
  assertPlainRecord(rawVariantMappings, 'Registry entry.specMappingByVariant');
  const variantEntries = ownStringKeys(rawVariantMappings, 'Registry entry.specMappingByVariant')
    .map((rawKey) => ({
      key: normalizeRegistryCode(rawKey),
      mapping: normalizedMapping(
        readOwnDataProperty(rawVariantMappings, rawKey, 'Registry entry.specMappingByVariant'),
        `Registry entry.specMappingByVariant.${rawKey}`,
      ),
    }));
  if (variantEntries.some(({ key, mapping }) => key === '' || mapping === null)) {
    invalidRegistry('Variant Spec mapping has an invalid key or value.');
  }
  if (new Set(variantEntries.map(({ key }) => key)).size !== variantEntries.length) {
    invalidRegistry('Variant keys collide after canonical normalization.');
  }
  const variants = Object.fromEntries(
    variantEntries
      .sort((a, b) => compareCodePoints(a.key, b.key))
      .map(({ key, mapping }) => [key, mapping])
  ) as Record<string, SpecProductMapping>;
  const normalizedProduct = normalizeRegistryCode(adapterProduct);
  if (!normalizedProduct) {
    invalidRegistry('Registry identity has invalid required fields.');
  }
  if (normalizedObserverOnlyAliases.some((alias) => !normalizedAliases.includes(alias))) {
    invalidRegistry(`${normalizedProduct} has an observer-only alias outside aliases.`);
  }
  if (new Set(normalizedObserverOnlyAliases).size !== normalizedObserverOnlyAliases.length) {
    invalidRegistry(`${adapterProduct} contains duplicate observer aliases.`);
  }
  return {
    adapterProduct: normalizedProduct as AdapterProductCode,
    vendor: vendor as 'SANGFOR' | 'FORTINET' | 'CISCO',
    aliases: normalizedAliases,
    observerOnlyAliases: normalizedObserverOnlyAliases,
    observerEligible,
    defaultSpecMapping: normalizedMapping(fields.defaultSpecMapping, 'Registry entry.defaultSpecMapping'),
    specMappingByVariant: variants,
  };
}

function canonicalizeRegistryEntries(value: unknown): ProductRegistryEntry[] {
  const rawEntries = denseDataArray(value, 'Registry view.entries');
  if (rawEntries.length === 0) invalidRegistry('Registry view must contain entries.');
  const normalizedEntries = rawEntries
    .map((entry) => normalizedEntry(entry))
    .sort((left, right) => compareCodePoints(left.adapterProduct, right.adapterProduct));
  const products = new Set<string>();
  for (const entry of normalizedEntries) {
    if (products.has(entry.adapterProduct)) invalidRegistry('Registry contains duplicate product codes.');
    products.add(entry.adapterProduct);
    if (entry.observerOnlyAliases.some((alias) => !entry.aliases.includes(alias))) {
      invalidRegistry(`${entry.adapterProduct} has an observer-only alias outside aliases.`);
    }
  }
  return deepFreeze(normalizedEntries);
}

function registryDigestFromCanonicalEntries(canonicalEntries: readonly ProductRegistryEntry[]): string {
  const digestEntries = canonicalEntries.map((entry) => ({
      adapterProduct: entry.adapterProduct,
      vendor: entry.vendor,
      aliases: entry.aliases,
      observerOnlyAliases: entry.observerOnlyAliases,
      observerEligible: entry.observerEligible,
      defaultSpecMapping: entry.defaultSpecMapping,
      specMappingByVariant: entry.specMappingByVariant,
  }));
  return createHash('sha256').update(stableJson({ schemaVersion: 1, entries: digestEntries })).digest('hex');
}

/**
 * Digest only canonical identity data. Product/alias/variant/spec codes and
 * accepted return codes are normalized, sorted, and deduplicated first.
 */
export function computeProductRegistryDigest(entries: readonly ProductRegistryEntry[]): string {
  return registryDigestFromCanonicalEntries(canonicalizeRegistryEntries(entries));
}

export function createProductRegistryView(entries: readonly ProductRegistryEntry[]): ProductRegistryView {
  const normalizedEntries = canonicalizeRegistryEntries(entries);
  const view: ProductRegistryView = {
    schemaVersion: 1,
    registryDigest: registryDigestFromCanonicalEntries(normalizedEntries),
    entries: normalizedEntries,
  };
  return deepFreeze(view);
}

export function validateProductRegistryView(view: ProductRegistryView): ProductRegistryView {
  const fields = exactOwnDataRecord(view, REGISTRY_VIEW_KEYS, 'Registry view');
  const schemaVersion = fields.schemaVersion;
  const registryDigest = fields.registryDigest;
  if (schemaVersion !== 1 || typeof registryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(registryDigest)) {
    invalidRegistry('Registry view schema or digest is invalid.');
  }
  const normalizedEntries = canonicalizeRegistryEntries(fields.entries);
  const expectedDigest = registryDigestFromCanonicalEntries(normalizedEntries);
  if (expectedDigest !== registryDigest) {
    throw new ProductRegistryError('REGISTRY_DRIFT', 'Registry digest does not match canonical identity data.');
  }
  return deepFreeze({
    schemaVersion: 1,
    registryDigest,
    entries: normalizedEntries,
  });
}

export function resolveInjectedAdapterProductCode(
  view: ProductRegistryView,
  product: string,
  options: InjectedRegistryResolveOptions = {},
): AdapterProductCode {
  const canonicalView = validateProductRegistryView(view);
  const optionFields = optionalOwnDataRecord(options, RESOLVE_OPTION_KEYS, 'Resolver options');
  const expectedRegistryDigest = optionFields.expectedRegistryDigest;
  const productVariant = optionFields.productVariant;
  if (typeof product !== 'string') throw new ProductRegistryError('UNSUPPORTED_PRODUCT', 'Product identity must be a string.');
  if (expectedRegistryDigest !== undefined
    && (typeof expectedRegistryDigest !== 'string' || expectedRegistryDigest !== canonicalView.registryDigest)) {
    throw new ProductRegistryError('REGISTRY_DRIFT', 'Injected registry digest differs from the expected digest.');
  }
  if (productVariant !== undefined && productVariant !== null && typeof productVariant !== 'string') {
    throw new ProductRegistryError('SPEC_IDENTITY_MISMATCH', 'Product variant must be a string or null.');
  }
  const normalized = normalizeRegistryAlias(product);
  const matches = canonicalView.entries.filter((entry) => (
    normalizeRegistryAlias(entry.adapterProduct) === normalized || entry.aliases.includes(normalized)
  ));
  if (matches.length === 0) throw new ProductRegistryError('UNSUPPORTED_PRODUCT', `No identity matches ${String(product)}.`);
  if (matches.length > 1) throw new ProductRegistryError('AMBIGUOUS_PRODUCT', `Multiple identities match ${String(product)}.`);
  const match = matches[0]!;
  if (!match.observerEligible) throw new ProductRegistryError('UNSUPPORTED_PRODUCT', `${match.adapterProduct} is not observer eligible.`);
  if (productVariant !== undefined && productVariant !== null) {
    const variant = normalizeRegistryCode(productVariant);
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
