import type { FirmwareIdentity } from '@sangfor/version';

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

export interface ResolvedFirmwareIdentity extends Omit<FirmwareIdentity, 'adapterProduct'> {
  adapterProduct: AdapterProductCode;
}
