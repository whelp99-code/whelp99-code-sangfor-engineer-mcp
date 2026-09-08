import { z } from 'zod';
import type { RuntimeCodec } from '../../shared/src/runtime-schema.js';
import type { RagDocumentChunk } from './rag-types.js';
import type { ShardedJsonlManifest } from './storage.js';

const idSchema = z.string().min(1).max(512);
const textSchema = z.string().max(16 * 1024 * 1024);
const timestampSchema = z.string().min(1).max(128);
const productSchema = z.enum([
  'HCI_SCP', 'HCI', 'NGFW', 'SCC', 'IAG', 'ENDPOINT_SECURE',
  'NDR', 'CYBER_COMMAND', 'HIWARE', 'OTHER',
]);
const embeddingBackendSchema = z.enum(['rapid-mlx', 'litellm', 'mimo', 'hash']);
const vectorSchema = z.array(z.number().finite()).max(16_384);

const chunkFields = {
  id: idSchema,
  sourceType: z.enum(['manual', 'wiki', 'lesson', 'pattern']),
  product: productSchema,
  version: z.string().max(256).optional(),
  title: textSchema,
  section: textSchema.optional(),
  text: textSchema,
  trustLevel: z.enum(['official', 'internal', 'draft', 'needs_review', 'customer']),
  contentHash: z.string().min(1).max(512),
  filePath: z.string().min(1).max(16_384),
  tenantId: idSchema.optional(),
  projectId: idSchema.optional(),
  aclActorIds: z.array(idSchema).max(100_000).optional(),
  embeddingBackend: embeddingBackendSchema.optional(),
  embeddingModel: z.string().max(512).optional(),
  vectorDims: z.number().int().positive().max(16_384).optional(),
};

export const ragDocumentChunkRuntimeSchema: RuntimeCodec<RagDocumentChunk> = z.object({
  ...chunkFields,
  vector: vectorSchema,
}).strict();

export const storedRagChunkRuntimeSchema = z.object({
  ...chunkFields,
  vector: vectorSchema.optional(),
  vectorB64: z.string().max(16 * 1024 * 1024).optional(),
}).strict().refine(
  (chunk) => chunk.vector !== undefined || chunk.vectorB64 !== undefined,
  { message: 'stored chunk requires vector or vectorB64' },
);

export type StoredRagIndex = {
  readonly version: 1 | 2;
  readonly chunks: z.output<typeof storedRagChunkRuntimeSchema>[];
  readonly updatedAt: string;
};

export const storedRagIndexRuntimeSchema: RuntimeCodec<StoredRagIndex> = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  chunks: z.array(storedRagChunkRuntimeSchema).max(100_000),
  updatedAt: timestampSchema,
}).strict();

export const rerankResponseRuntimeSchema = z.object({
  ranked: z.array(idSchema).max(100_000).optional(),
}).strict().superRefine(({ ranked }, context) => {
  if (ranked !== undefined && new Set(ranked).size !== ranked.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'ranked ids must be unique', path: ['ranked'] });
  }
});

const shardSchema = z.object({
  product: idSchema,
  file: z.string().min(1).max(512).refine(
    (file) => !file.includes('/') && !file.includes('\\') && file.endsWith('.jsonl'),
    { message: 'shard file must be a confined JSONL name' },
  ),
  chunkCount: z.number().int().nonnegative(),
}).strict();

export const shardedManifestRuntimeSchema: RuntimeCodec<ShardedJsonlManifest> = z.object({
  schemaVersion: z.literal(1),
  source: z.literal('rag-index-v2'),
  updatedAt: timestampSchema,
  chunkCount: z.number().int().nonnegative(),
  shards: z.array(shardSchema).max(10_000),
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.shards.map(({ file }) => file)).size !== manifest.shards.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'shard files must be unique', path: ['shards'] });
  }
  const count = manifest.shards.reduce((total, shard) => total + shard.chunkCount, 0);
  if (count !== manifest.chunkCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'chunk count mismatch', path: ['chunkCount'] });
  }
});
