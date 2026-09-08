import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveEmbeddingProfile } from './embedding-profile.js';
import type { EmbeddingBackend } from './embedding-provider-types.js';

/** Persisted identity of the transformation that produced the vector, not just its width. */
export const embeddingSpaceSchema = z.object({
  schemaVersion: z.literal(1),
  model: z.string().trim().min(1).max(512),
  revision: z.string().trim().min(1).max(512),
  dimensions: z.number().int().positive().max(16_384),
  normalization: z.literal('cosine-l2-at-search-v1'),
  preprocessing: z.literal('rag-text-role-prefix-v1'),
  queryPrefix: z.string().max(4096),
  documentPrefix: z.string().max(4096),
}).strict();

export type EmbeddingSpace = z.infer<typeof embeddingSpaceSchema>;

/** Unpinned semantic models remain readable lexically, but cannot authorize vector comparisons. */
export function resolveEmbeddingSpace(
  model: string,
  dimensions: number,
  backend: EmbeddingBackend,
  revision = process.env.SANGFOR_EMBEDDING_MODEL_REVISION?.trim(),
): EmbeddingSpace | undefined {
  if (backend === 'hash') { model = 'hash'; revision = 'sha256-buckets-v1'; }
  if (!revision) return undefined;
  const profile = resolveEmbeddingProfile(model, dimensions);
  return embeddingSpaceSchema.parse({
    schemaVersion: 1, model, revision, dimensions,
    normalization: 'cosine-l2-at-search-v1', preprocessing: 'rag-text-role-prefix-v1',
    queryPrefix: profile.queryPrefix, documentPrefix: profile.documentPrefix,
  });
}

export function embeddingSpaceId(space: EmbeddingSpace): string {
  return createHash('sha256').update(JSON.stringify(embeddingSpaceSchema.parse(space))).digest('hex');
}

export function sameEmbeddingSpace(left: EmbeddingSpace | undefined, right: EmbeddingSpace | undefined): boolean {
  return !!left && !!right && left.schemaVersion === right.schemaVersion
    && left.model === right.model && left.revision === right.revision
    && left.dimensions === right.dimensions && left.normalization === right.normalization
    && left.preprocessing === right.preprocessing
    && left.queryPrefix === right.queryPrefix && left.documentPrefix === right.documentPrefix;
}
