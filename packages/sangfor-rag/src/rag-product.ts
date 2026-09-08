import { PRODUCTS, type ProductCode } from '@sangfor/shared';

/** Retrieval filters must not inherit the advisory normalizer's unknown → HCI default. */
export function resolveRagProduct(input: string): ProductCode {
  const key = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const normalized = key(input);
  const product = PRODUCTS.find((candidate) => [candidate.code, candidate.name, ...candidate.aliases]
    .some((alias) => key(alias) === normalized));
  if (!product) throw new Error('RAG_PRODUCT_UNKNOWN');
  return product.code;
}
