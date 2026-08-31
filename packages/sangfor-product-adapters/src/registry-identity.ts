import type { AdapterProductCode, ProductRegistryView, SpecProductMapping } from '@sangfor/learning-strategy';
import { LEGACY_ADAPTERS } from './product-catalog.js';
import {
  canonicalRegistryEntries,
  canonicalRegistryEntry,
  cloneAdapterIdentity,
  cloneRequiredSpecMapping,
  cloneSpecMapping,
  compareCodePoints,
  deepFreeze,
  normalizeIdentityAlias,
  normalizeIdentityCode,
  productRegistryDigestFromCanonicalEntries,
  stableRegistryJson,
  validateStrictSnapshot,
} from './registry-codec.js';
import {
  assertPlainRecord,
  assertStrictObjectKeys,
  hasOwnProperty,
  isPlainRecord,
  readOwnDataProperty,
  strictProductVariant,
  strictRegistryDigest,
} from './registry-object.js';
import type {
  AdapterIdentity,
  AdapterRegistry,
  AdapterRegistryEntry,
  ObserverAdapterProductCode,
  StrictProductResolveOptions,
  StrictProductResolveRequest,
} from './types.js';

function specMapping(lookupCode: string, acceptedReturnedCodes: string[]): SpecProductMapping {
  return { lookupCode, acceptedReturnedCodes: acceptedReturnedCodes as [string, ...string[]] };
}

function identity<C extends ObserverAdapterProductCode>(
  adapterProduct: C,
  vendor: AdapterIdentity<C>['vendor'],
  aliases: string[],
  observerOnlyAliases: string[],
  defaultSpecMapping: SpecProductMapping | null,
  specMappingByVariant: Record<string, SpecProductMapping> = {},
): AdapterIdentity<C> {
  return {
    adapterProduct,
    vendor,
    aliases,
    observerOnlyAliases,
    observerEligible: true,
    defaultSpecMapping,
    specMappingByVariant,
  };
}

/**
 * The only product identity source. Legacy APIs below intentionally consume
 * LEGACY_ADAPTERS, so adding observer-only identities cannot change them.
 */
const ADAPTERS: AdapterRegistry = Object.freeze({
  HCI_SCP: {
    identity: identity('HCI_SCP', 'SANGFOR', [...LEGACY_ADAPTERS.HCI_SCP.aliases], [], specMapping('HCI_SCP', ['HCI_SCP', 'HCI'])),
    legacyAdapter: LEGACY_ADAPTERS.HCI_SCP,
  },
  IAG: {
    identity: identity('IAG', 'SANGFOR', [...LEGACY_ADAPTERS.IAG.aliases], [], specMapping('IAG', ['IAG'])),
    legacyAdapter: LEGACY_ADAPTERS.IAG,
  },
  ENDPOINT_SECURE: {
    identity: identity('ENDPOINT_SECURE', 'SANGFOR', [...LEGACY_ADAPTERS.ENDPOINT_SECURE.aliases, 'A-Sec'], ['A-Sec'], specMapping('ENDPOINT_SECURE', ['ENDPOINT_SECURE'])),
    legacyAdapter: LEGACY_ADAPTERS.ENDPOINT_SECURE,
  },
  NDR: {
    identity: identity('NDR', 'SANGFOR', [...LEGACY_ADAPTERS.NDR.aliases, 'CC', 'Athena XDR'], ['CC', 'Athena XDR'], null, {
      CYBER_COMMAND: specMapping('CYBER_COMMAND', ['CYBER_COMMAND']),
      ATHENA_XDR: specMapping('XDR', ['XDR']),
    }),
    legacyAdapter: LEGACY_ADAPTERS.NDR,
  },
  FORTIOS: {
    identity: identity('FORTIOS', 'FORTINET', ['FortiOS', 'FortiGate'], ['FortiOS', 'FortiGate'], specMapping('FORTIOS', ['FORTIOS'])),
    legacyAdapter: null,
  },
  IOSXE: {
    identity: identity('IOSXE', 'CISCO', ['IOS XE', 'Cisco IOSXE'], ['IOS XE', 'Cisco IOSXE'], specMapping('CISCO_IOSXE', ['CISCO_IOSXE'])),
    legacyAdapter: null,
  },
} as AdapterRegistry);

function assertLegacyIdentityInvariant(entry: AdapterRegistryEntry): void {
  const identityAliases = new Set(entry.identity.aliases.map(normalizeIdentityAlias));
  const legacyAliases = new Set(entry.legacyAdapter?.aliases.map(normalizeIdentityAlias) ?? []);
  if ([...legacyAliases].some((alias) => !identityAliases.has(alias))) {
    throw new Error(`INVALID_REGISTRY: ${entry.identity.adapterProduct} legacy alias is absent from identity aliases.`);
  }
  const expectedObserverOnly = [...identityAliases].filter((alias) => !legacyAliases.has(alias)).sort(compareCodePoints);
  const actualObserverOnly = [...new Set(entry.identity.observerOnlyAliases.map(normalizeIdentityAlias))].sort(compareCodePoints);
  if (JSON.stringify(expectedObserverOnly) !== JSON.stringify(actualObserverOnly)) {
    throw new Error(`INVALID_REGISTRY: ${entry.identity.adapterProduct} observerOnlyAliases is not the exact legacy difference.`);
  }
}

/*
 * Validate the public legacy relationship once, then retain only a defensive
 * canonical identity seed. Snapshot construction must not read the mutable
 * legacy singleton again.
 */
const ADAPTER_IDENTITY_SEED = deepFreeze(
  Object.fromEntries(Object.entries(ADAPTERS).map(([adapterProduct, entry]) => {
    assertLegacyIdentityInvariant(entry);
    return [adapterProduct, cloneAdapterIdentity(entry.identity)];
  })),
) as Readonly<Record<ObserverAdapterProductCode, AdapterIdentity>>;

export function getProductRegistrySnapshot(): ProductRegistryView {
  const entries = (Object.keys(ADAPTER_IDENTITY_SEED) as ObserverAdapterProductCode[]).map((adapterProduct) => {
    const identity = ADAPTER_IDENTITY_SEED[adapterProduct];
    return canonicalRegistryEntry({
      adapterProduct: identity.adapterProduct as AdapterProductCode,
      vendor: identity.vendor,
      aliases: identity.aliases,
      observerOnlyAliases: identity.observerOnlyAliases,
      observerEligible: identity.observerEligible,
      defaultSpecMapping: identity.defaultSpecMapping,
      specMappingByVariant: identity.specMappingByVariant,
    });
  });
  const canonicalEntries = canonicalRegistryEntries(entries);
  const snapshotEntries = (Object.keys(ADAPTER_IDENTITY_SEED) as ObserverAdapterProductCode[]).map((adapterProduct) => {
    const entry = canonicalEntries.find((candidate) => candidate.adapterProduct === adapterProduct);
    if (entry === undefined) throw new Error(`INVALID_REGISTRY: ${adapterProduct} is absent from the canonical registry.`);
    return entry;
  });
  const view = {
    schemaVersion: 1 as const,
    registryDigest: productRegistryDigestFromCanonicalEntries(canonicalEntries),
    entries: snapshotEntries,
  } satisfies ProductRegistryView;
  return deepFreeze(view);
}

const STRICT_REQUEST_KEYS = new Set([
  'product', 'input', 'adapterProduct', 'productVariant', 'registryDigest', 'registry', 'snapshot',
]);
const STRICT_OPTION_KEYS = new Set(['snapshot', 'registryDigest', 'productVariant']);

function strictInput(input: string | StrictProductResolveRequest): StrictProductResolveRequest {
  if (typeof input === 'string') return { product: input };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('UNSUPPORTED_PRODUCT: strict identity request must be an object or string.');
  }
  assertPlainRecord(input, 'strict identity request');
  assertStrictObjectKeys(input, STRICT_REQUEST_KEYS, 'strict identity request');
  return input;
}

export function resolveProductAdapterStrict(
  input: string | StrictProductResolveRequest,
  options: StrictProductResolveOptions = {},
): AdapterIdentity {
  const request = strictInput(input);
  if (!isPlainRecord(options)) {
    throw new Error('INVALID_REGISTRY: strict resolver options must be an object.');
  }
  assertStrictObjectKeys(options, STRICT_OPTION_KEYS, 'strict resolver options');

  const requestSnapshotKeys = ['registry', 'snapshot'].filter((key) => hasOwnProperty(request, key));
  if (requestSnapshotKeys.length > 1) {
    throw new Error('INVALID_REGISTRY: request cannot provide both registry and snapshot.');
  }
  const requestSnapshotKey = requestSnapshotKeys[0];
  const requestSnapshot = requestSnapshotKey === undefined
    ? undefined
    : readOwnDataProperty(request, requestSnapshotKey, 'strict identity request');
  const validatedRequestSnapshot = requestSnapshotKey === undefined
    ? undefined
    : validateStrictSnapshot(requestSnapshot);
  const validatedOptionsSnapshot = hasOwnProperty(options, 'snapshot')
    ? validateStrictSnapshot(readOwnDataProperty(options, 'snapshot', 'strict resolver options'))
    : undefined;
  const validatedAuthoritySnapshot = validatedOptionsSnapshot ?? validateStrictSnapshot(getProductRegistrySnapshot());
  if (validatedRequestSnapshot
    && (validatedRequestSnapshot.registryDigest !== validatedAuthoritySnapshot.registryDigest
      || stableRegistryJson(validatedRequestSnapshot.canonicalEntries) !== stableRegistryJson(validatedAuthoritySnapshot.canonicalEntries))) {
    throw new Error('REGISTRY_DRIFT: request registry differs from the authoritative options snapshot.');
  }
  const validatedSnapshot = validatedAuthoritySnapshot;
  const requestDigest = strictRegistryDigest(
    readOwnDataProperty(request, 'registryDigest', 'strict identity request'),
    'request.registryDigest',
  );
  const optionsDigest = strictRegistryDigest(
    readOwnDataProperty(options, 'registryDigest', 'strict resolver options'),
    'options.registryDigest',
  );
  if (requestDigest !== undefined && optionsDigest !== undefined && requestDigest !== optionsDigest) {
    throw new Error('REGISTRY_DRIFT: request and options registry digests differ.');
  }
  const expectedDigest = optionsDigest ?? requestDigest;
  if (expectedDigest !== undefined && expectedDigest !== validatedSnapshot.registryDigest) {
    throw new Error('REGISTRY_DRIFT: expected registry digest differs.');
  }
  const productKeys = ['product', 'input', 'adapterProduct'].filter((key) => hasOwnProperty(request, key));
  if (productKeys.length > 1) {
    throw new Error('AMBIGUOUS_PRODUCT: request provides multiple product identity fields.');
  }
  const productKey = productKeys[0];
  const product = productKey === undefined
    ? undefined
    : readOwnDataProperty(request, productKey, 'strict identity request');
  if (product !== undefined && typeof product !== 'string') {
    throw new Error('UNSUPPORTED_PRODUCT: strict identity product must be a string.');
  }
  const normalized = product === undefined ? '' : normalizeIdentityAlias(product);
  const requestVariant = strictProductVariant(
    readOwnDataProperty(request, 'productVariant', 'strict identity request'),
    'request.productVariant',
  );
  const optionsVariant = strictProductVariant(
    readOwnDataProperty(options, 'productVariant', 'strict resolver options'),
    'options.productVariant',
  );
  if (requestVariant !== undefined && optionsVariant !== undefined) {
    const canonicalRequestVariant = requestVariant === null ? null : normalizeIdentityCode(requestVariant);
    const canonicalOptionsVariant = optionsVariant === null ? null : normalizeIdentityCode(optionsVariant);
    if (canonicalRequestVariant !== canonicalOptionsVariant) {
      throw new Error('SPEC_IDENTITY_MISMATCH: request and options product variants differ.');
    }
  }
  const canonicalEntries = validatedSnapshot.canonicalEntries;
  const matches = canonicalEntries.filter((entry) => (
    normalizeIdentityAlias(entry.adapterProduct) === normalized || entry.aliases.includes(normalized)
  ));
  if (matches.length === 0) throw new Error(`UNSUPPORTED_PRODUCT: no strict identity matches ${String(product)}.`);
  if (matches.length > 1) throw new Error(`AMBIGUOUS_PRODUCT: multiple strict identities match ${String(product)}.`);
  const match = matches[0];
  if (match === undefined) throw new Error(`UNSUPPORTED_PRODUCT: no strict identity matches ${String(product)}.`);
  if (!match.observerEligible) throw new Error(`UNSUPPORTED_PRODUCT: ${match.adapterProduct} is not observer eligible.`);
  const variant = requestVariant !== undefined ? requestVariant : optionsVariant;
  if (variant !== undefined && variant !== null) {
    const normalizedVariant = normalizeIdentityCode(variant);
    if (!Object.prototype.hasOwnProperty.call(match.specMappingByVariant, normalizedVariant)) {
      throw new Error(`SPEC_IDENTITY_MISMATCH: ${match.adapterProduct} has no mapping for ${normalizedVariant}.`);
    }
  }
  return {
    adapterProduct: match.adapterProduct as ObserverAdapterProductCode,
    vendor: match.vendor,
    aliases: [...match.aliases],
    observerOnlyAliases: [...match.observerOnlyAliases],
    observerEligible: match.observerEligible,
    defaultSpecMapping: cloneSpecMapping(match.defaultSpecMapping),
    specMappingByVariant: Object.fromEntries(Object.entries(match.specMappingByVariant).map(([key, mapping]) => [key, cloneRequiredSpecMapping(mapping)])),
  };
}
