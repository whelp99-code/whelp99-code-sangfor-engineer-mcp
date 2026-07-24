import {
  isFirmwareTruthEligible,
  parseFirmwareTruthRecord,
  toFirmwareIdentity,
  type EvidenceRootOptions,
  type FirmwareTruthRecord,
} from '@sangfor/version';
import {
  normalizeRegistryCode,
  resolveInjectedAdapterProductCode,
  type AdapterProductCode,
  type ProductRegistryView,
  type ResolvedFirmwareIdentity,
} from './contracts.js';

export * from './contracts.js';
export * from './approval.js';
export * from './methods.js';
export * from './store.js';
export * from './lifecycle.js';
export * from './resolver.js';
export {
  canonicalizeFingerprintDescriptors,
  fingerprintFromDescriptors,
  FirmwareTruthError,
  isEligibleFirmwareTruth,
  isEvidenceFileConfined,
  isFirmwareTruthEligible,
  loadFirmwareTruthRecords,
  parseFirmwareTruthRecord,
  sameFirmwareIdentity,
  toFirmwareIdentity,
  transitionFirmwareTruthStatus,
  type EvidenceRootOptions,
  type FirmwareIdentity,
  type FirmwareTruthRecord,
  type FirmwareTruthStatus,
  type FirmwareTruthVendor,
  type SpecApplicability,
} from '@sangfor/version';

export interface VerifiedFirmwareIdentityOptions extends EvidenceRootOptions {
  expectedRegistryDigest?: string;
}

/**
 * Resolve a version record only after the caller injects and validates the
 * ADAPTERS-derived view. The returned adapterProduct is branded at this L1
 * boundary; no product-adapters import is allowed here.
 */
export function resolveVerifiedFirmwareIdentity(
  record: FirmwareTruthRecord,
  registry: ProductRegistryView,
  options: VerifiedFirmwareIdentityOptions,
): ResolvedFirmwareIdentity {
  const parsed = parseFirmwareTruthRecord(record);
  if (parsed.status === 'conflict') {
    throw new Error('VERSION_CONFLICT: conflicted firmware truth is not eligible.');
  }
  if (parsed.status !== 'verified' || !isFirmwareTruthEligible(parsed, options)) {
    throw new Error('VERSION_TRUTH_UNAVAILABLE: verified firmware evidence is not confined and eligible.');
  }
  const adapterProduct: AdapterProductCode = resolveInjectedAdapterProductCode(registry, parsed.adapterProduct, {
    expectedRegistryDigest: options.expectedRegistryDigest,
    productVariant: parsed.productVariant,
  });
  if (normalizeRegistryCode(adapterProduct) !== normalizeRegistryCode(parsed.adapterProduct)) {
    throw new Error('REGISTRY_DRIFT: firmware truth product does not match the injected registry.');
  }
  return { ...toFirmwareIdentity(parsed), adapterProduct };
}

export const resolveExactFirmwareIdentity = resolveVerifiedFirmwareIdentity;
