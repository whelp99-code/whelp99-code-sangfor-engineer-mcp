import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PRODUCTS } from '@sangfor/shared';
import { z } from 'zod';
import type { BenchmarkCorpus } from './benchmark-schema.js';
import { BenchmarkRefusal } from './benchmark-schema.js';

const VendorRegistrySchema = z.array(z.object({
  product: z.string().min(1),
  label: z.string().min(1),
  advisorTools: z.array(z.string()),
  credentialFields: z.array(z.string()),
  defaultArgs: z.record(z.string(), z.unknown())
}).strict());

export type RegisteredProducts = {
  readonly products: readonly string[];
  readonly sharedProducts: readonly string[];
  readonly vendorProducts: readonly string[];
};

export type BenchmarkCoverage = RegisteredProducts & {
  readonly missingProducts: readonly string[];
  readonly filters: {
    readonly tenant: boolean;
    readonly project: boolean;
    readonly actorAcl: boolean;
    readonly trust: boolean;
    readonly version: boolean;
    readonly sourceType: boolean;
    readonly noResult: boolean;
  };
};

export function deriveRegisteredProducts(): RegisteredProducts {
  const registryPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/registry/vendors.json');
  const vendorParsed = VendorRegistrySchema.safeParse(JSON.parse(readFileSync(registryPath, 'utf8')));
  if (!vendorParsed.success) throw new BenchmarkRefusal('PRODUCT_REGISTRY_INVALID', vendorParsed.error.message);
  const sharedProducts = PRODUCTS.map((product) => product.code).sort((left, right) => left.localeCompare(right));
  const vendorProducts = vendorParsed.data.map((vendor) => vendor.product).sort((left, right) => left.localeCompare(right));
  const products = [...new Set([...sharedProducts, ...vendorProducts])].sort((left, right) => left.localeCompare(right));
  return { products, sharedProducts, vendorProducts };
}

export function deriveBenchmarkCoverage(corpus: BenchmarkCorpus): BenchmarkCoverage {
  const registry = deriveRegisteredProducts();
  const covered = new Set(corpus.queries.map((query) => query.filters.product).filter((product): product is string => typeof product === 'string'));
  const missingProducts = registry.products.filter((product) => !covered.has(product));
  if (missingProducts.length > 0) throw new BenchmarkRefusal('PRODUCT_COVERAGE_INCOMPLETE', missingProducts.join(','));
  const scopeQueries = corpus.queries.filter((query) => query.forbiddenIds.length > 0);
  const allTrust = new Set(corpus.chunks.map((chunk) => chunk.trustLevel));
  const allSources = new Set(corpus.chunks.map((chunk) => chunk.sourceType));
  return {
    ...registry,
    missingProducts,
    filters: {
      tenant: scopeQueries.some((query) => query.forbiddenIds.some((id) => id.includes('cross-tenant'))),
      project: scopeQueries.some((query) => query.forbiddenIds.some((id) => id.includes('cross-project'))),
      actorAcl: scopeQueries.some((query) => query.forbiddenIds.some((id) => id.includes('acl-denied'))),
      trust: allTrust.size > 1 && corpus.queries.some((query) => query.filters.trustLevel !== undefined),
      version: new Set(corpus.chunks.map((chunk) => chunk.version)).size > 1 && corpus.queries.some((query) => query.filters.version !== undefined),
      sourceType: allSources.size > 1 && corpus.queries.some((query) => query.filters.sourceType !== undefined),
      noResult: corpus.queries.some((query) => query.expectedIds.length === 0)
    }
  };
}
