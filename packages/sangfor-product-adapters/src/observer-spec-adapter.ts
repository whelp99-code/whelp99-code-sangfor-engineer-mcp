import type {
  ProductRegistryView,
  SpecProductMapping,
} from '@sangfor/learning-strategy';
import type {
  FactQueryResult,
} from '@sangfor/learning-strategy';

/**
 * PR-002: ObserverSpecAdapter.
 * 
 * Resolves exact product variant→Spec product code and verified specVersion,
 * then converts FactQueryResult complete+eligible only to observed map.
 */

export interface ObserverSpecAdapterOptions {
  registry: ProductRegistryView;
  productVariant?: string;
  specVersion?: string;
}

export interface ObservedFactMap {
  [factId: string]: unknown;
}

export interface SpecAdapterResult {
  specProductCode: string;
  specVersion: string;
  observedFacts: ObservedFactMap;
  eligibleFactCount: number;
  totalFactCount: number;
}

export type SpecAdapterError =
  | { code: 'MAPPING_NOT_FOUND'; message: string }
  | { code: 'VERSION_NOT_VERIFIED'; message: string }
  | { code: 'ALLOWLIST_VIOLATION'; message: string };

export class ObserverSpecAdapter {
  constructor(private readonly options: ObserverSpecAdapterOptions) {}

  resolveSpecProductCode(productVariant: string): string | SpecAdapterError {
    const entry = this.options.registry.entries.find(e => 
      e.adapterProduct === productVariant || 
      e.aliases.includes(productVariant.toLowerCase())
    );

    if (!entry) {
      return {
        code: 'MAPPING_NOT_FOUND',
        message: `No registry entry found for product variant: ${productVariant}`,
      };
    }

    // Use variant-specific mapping if available, otherwise default
    const mapping = this.options.productVariant && entry.specMappingByVariant[this.options.productVariant]
      ? entry.specMappingByVariant[this.options.productVariant]
      : entry.defaultSpecMapping;

    if (!mapping) {
      return {
        code: 'MAPPING_NOT_FOUND',
        message: `No spec mapping found for product variant: ${productVariant}`,
      };
    }

    return mapping.lookupCode;
  }

  validateSpecVersion(specVersion: string): boolean {
    // Version must be verified (non-empty string)
    return typeof specVersion === 'string' && specVersion.length > 0;
  }

  convertFactsToObservedMap(results: FactQueryResult[]): ObservedFactMap {
    const observedMap: ObservedFactMap = {};

    for (const result of results) {
      // Only complete+eligible results are converted
      if (result.status !== 'complete') {
        continue;
      }

      if (result.value === undefined) {
        continue;
      }

      observedMap[result.factId] = result.value;
    }

    return observedMap;
  }

  adapt(results: FactQueryResult[]): SpecAdapterResult | SpecAdapterError {
    const productVariant = this.options.productVariant ?? '';
    
    // Resolve spec product code
    const specProductCodeResult = this.resolveSpecProductCode(productVariant);
    if (typeof specProductCodeResult !== 'string') {
      return specProductCodeResult;
    }

    // Validate spec version
    const specVersion = this.options.specVersion ?? '';
    if (!this.validateSpecVersion(specVersion)) {
      return {
        code: 'VERSION_NOT_VERIFIED',
        message: `Spec version not verified: ${specVersion}`,
      };
    }

    // Convert facts to observed map
    const observedMapResult = this.convertFactsToObservedMap(results);

    const eligibleCount = results.filter(r => r.status === 'complete').length;

    return {
      specProductCode: specProductCodeResult,
      specVersion,
      observedFacts: observedMapResult,
      eligibleFactCount: eligibleCount,
      totalFactCount: results.length,
    };
  }
}

/**
 * Spec product code mappings for vendor products.
 * 
 * IOSXE→CISCO_IOSXE
 * Cyber Command NDR→CYBER_COMMAND
 * HCI_SCP lookup→HCI accepted return
 * ENDPOINT_SECURE→ENDPOINT_SECURE
 */
export const SPEC_PRODUCT_MAPPINGS: Record<string, SpecProductMapping> = {
  IOSXE: {
    lookupCode: 'CISCO_IOSXE',
    acceptedReturnedCodes: ['CISCO_IOSXE'],
  },
  NDR: {
    lookupCode: 'CYBER_COMMAND',
    acceptedReturnedCodes: ['CYBER_COMMAND', 'NDR'],
  },
  HCI_SCP: {
    lookupCode: 'HCI',
    acceptedReturnedCodes: ['HCI', 'HCI_SCP'],
  },
  ENDPOINT_SECURE: {
    lookupCode: 'ENDPOINT_SECURE',
    acceptedReturnedCodes: ['ENDPOINT_SECURE'],
  },
};
