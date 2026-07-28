import {
  isFirmwareTruthEligible,
  parseFirmwareTruthRecord,
  toFirmwareIdentity,
  type EvidenceRootOptions,
  type FirmwareTruthRecord,
} from '@sangfor/version';
import {
  normalizeRegistryCode,
  resolveInjectedProductIdentity,
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
export * from './fact-service.js';
export * from './lm01-fortios.js';
export * from './lm02-replay.js';
export * from './lm03-extjs.js';
export * from './lm05-import.js';
export * from './lm07-ocr.js';
export * from './lr-research.js';
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
  const registryIdentity = resolveInjectedProductIdentity(registry, parsed.adapterProduct, {
    expectedRegistryDigest: options.expectedRegistryDigest,
    productVariant: parsed.productVariant,
  });
  const adapterProduct: AdapterProductCode = registryIdentity.adapterProduct;
  if (normalizeRegistryCode(adapterProduct) !== normalizeRegistryCode(parsed.adapterProduct)) {
    throw new Error('REGISTRY_DRIFT: firmware truth product does not match the injected registry.');
  }
  if (registryIdentity.vendor !== parsed.vendor) {
    throw new Error('SPEC_IDENTITY_MISMATCH: firmware truth vendor does not match the injected registry identity.');
  }
  return { ...toFirmwareIdentity(parsed), adapterProduct };
}

export const resolveExactFirmwareIdentity = resolveVerifiedFirmwareIdentity;
