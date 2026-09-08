export type { FirmwareIdentity, FirmwareTruthRecord } from '@sangfor/version';
export {
  normalizeRegistryAlias,
  normalizeRegistryCode,
  ProductRegistryError,
  type AdapterProductCode,
  type InjectedRegistryResolveOptions,
  type ProductRegistryEntry,
  type ProductRegistryErrorCode,
  type ProductRegistryView,
  type ResolvedFirmwareIdentity,
  type SpecProductMapping,
} from './registry-contracts.js';
export {
  computeProductRegistryDigest,
  createProductRegistryView,
  validateProductRegistryView,
} from './registry-validation.js';
export {
  resolveInjectedAdapterProductCode,
  resolveInjectedProductIdentity,
} from './registry-resolution.js';
