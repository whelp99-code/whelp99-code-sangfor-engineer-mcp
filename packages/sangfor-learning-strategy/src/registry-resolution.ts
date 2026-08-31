import {
  normalizeRegistryAlias,
  normalizeRegistryCode,
  ProductRegistryError,
  type AdapterProductCode,
  type InjectedRegistryResolveOptions,
  type ProductRegistryEntry,
  type ProductRegistryView,
} from './registry-contracts.js';
import { validateProductRegistryView } from './registry-validation.js';

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

function readOwnDataProperty(value: object, key: string, label: string): unknown {
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

function optionalOwnDataRecord(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) invalidRegistry(`${label} must be a plain object.`);
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    invalidRegistry(`${label} keys could not be inspected safely.`);
  }
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
    invalidRegistry(`${label} contains an unknown key.`);
  }
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of keys) fields[String(key)] = readOwnDataProperty(value, String(key), label);
  return fields;
}

export function resolveInjectedProductIdentity(
  view: ProductRegistryView,
  product: string,
  options: InjectedRegistryResolveOptions = {},
): ProductRegistryEntry {
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
  const match = matches[0];
  if (!match) throw new ProductRegistryError('UNSUPPORTED_PRODUCT', `No identity matches ${String(product)}.`);
  if (!match.observerEligible) throw new ProductRegistryError('UNSUPPORTED_PRODUCT', `${match.adapterProduct} is not observer eligible.`);
  if (productVariant !== undefined && productVariant !== null) {
    const variant = normalizeRegistryCode(productVariant);
    if (!Object.prototype.hasOwnProperty.call(match.specMappingByVariant, variant)) {
      throw new ProductRegistryError('SPEC_IDENTITY_MISMATCH', `${match.adapterProduct} has no mapping for ${variant}.`);
    }
  }
  return match;
}

export function resolveInjectedAdapterProductCode(
  view: ProductRegistryView,
  product: string,
  options: InjectedRegistryResolveOptions = {},
): AdapterProductCode {
  return resolveInjectedProductIdentity(view, product, options).adapterProduct;
}
