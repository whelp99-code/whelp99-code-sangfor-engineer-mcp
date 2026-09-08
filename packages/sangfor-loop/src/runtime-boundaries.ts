import { z } from 'zod';
import { parseRuntimeJson, type RuntimeCodec } from '../../shared/src/runtime-schema.js';
import type {
  CursorStore,
  LoopGraph,
  LoopLedgerEntry,
} from './index.js';
import type {
  GapEventLine,
  GapQueriesFile,
} from './executors/gap-queries.js';
import type { GapQueryEntry as LearnGapQueryEntry } from './executors/learn-sources.js';
import type { MinimalIndexChunk } from './executors/embedding-drift.js';

const idSchema = z.string().min(1).max(512);
const textSchema = z.string().max(16 * 1024 * 1024);
const timestampSchema = z.string().max(128);
const stringListSchema = z.array(z.string().max(16_384)).max(100_000);

const graphNodeSchema = z.object({
  id: idSchema,
  kind: idSchema,
  run: idSchema.optional(),
  tool: idSchema.optional(),
  src: stringListSchema.optional(),
  reads: stringListSchema,
  writes: stringListSchema,
  gate: z.literal('human-approval').optional(),
  note: textSchema.optional(),
}).strict();

const graphEdgeSchema = z.object({
  id: idSchema,
  from: idSchema,
  to: idSchema,
  on: z.enum(['new-jsonl-lines', 'file-changed', 'every-tick', 'manual']),
  watch: z.string().max(16_384).optional(),
}).strict();

const loopGraphSchema: RuntimeCodec<LoopGraph> = z.object({
  version: z.literal(1),
  nodes: z.array(graphNodeSchema).max(100_000),
  edges: z.array(graphEdgeSchema).max(100_000),
}).strict();

const cursorStoreSchema: RuntimeCodec<CursorStore> = z.record(
  idSchema,
  z.object({
    lines: z.number().int().nonnegative().optional(),
    mtimeMs: z.number().finite().nonnegative().optional(),
  }).strict(),
);

const loopLedgerSchema: RuntimeCodec<LoopLedgerEntry> = z.object({
  id: idSchema,
  ts: timestampSchema,
  tick: idSchema,
  edge: idSchema,
  node: idSchema,
  outcome: z.enum(['executed', 'noop', 'error', 'gate-pending', 'manual']),
  detail: textSchema.optional(),
}).strict();

const gapQueryEntrySchema = z.object({
  query: z.string().min(1).max(100_000),
  count: z.number().int().nonnegative(),
  products: z.array(idSchema).max(10_000),
  lastSeen: timestampSchema,
}).strict();

const gapQueriesSchema: RuntimeCodec<GapQueriesFile> = z.object({
  version: z.literal(1),
  updatedAt: timestampSchema,
  queries: z.array(gapQueryEntrySchema).max(100_000),
}).strict();

const gapEventSchema: RuntimeCodec<GapEventLine> = z.object({
  id: idSchema.optional(),
  ts: timestampSchema.optional(),
  query: z.string().min(1).max(100_000),
  product: idSchema.optional(),
  hitCount: z.number().int().nonnegative(),
  topScore: z.number().finite().optional(),
  reason: z.enum(['no_hits', 'low_score']),
}).strict();

const learnGapQuerySchema: RuntimeCodec<LearnGapQueryEntry> = z.object({
  query: z.string().min(1).max(100_000),
  count: z.number().int().nonnegative().optional(),
  products: z.array(idSchema).max(10_000).optional(),
  lastSeen: timestampSchema.optional(),
}).strict();

const embeddingChunkSchema = z.object({
  id: idSchema,
  sourceType: z.enum(['manual', 'wiki', 'lesson', 'pattern']),
  product: idSchema,
  version: z.string().max(256).optional(),
  title: textSchema,
  section: textSchema.optional(),
  text: textSchema,
  trustLevel: z.enum(['official', 'internal', 'draft', 'needs_review', 'customer']),
  contentHash: z.string().min(1).max(512),
  filePath: z.string().max(16_384),
  tenantId: idSchema.optional(),
  projectId: idSchema.optional(),
  aclActorIds: z.array(idSchema).max(100_000).optional(),
  embeddingBackend: z.enum(['rapid-mlx', 'litellm', 'mimo', 'hash']).optional(),
  embeddingModel: z.string().max(512).optional(),
  vectorDims: z.number().int().positive().max(100_000).optional(),
  vector: z.array(z.number().finite()).max(100_000).optional(),
  vectorB64: z.string().max(16 * 1024 * 1024).optional(),
}).strict();

const embeddingIndexSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  chunks: z.array(embeddingChunkSchema).max(100_000),
  updatedAt: timestampSchema,
}).strict().transform(({ chunks }) => ({
  chunks: chunks.map(({ embeddingModel }) => ({
    ...(embeddingModel === undefined ? {} : { embeddingModel }),
  })),
}));

export function parseBoundaryLoopEmbeddingIndexV1(source: string): { chunks: MinimalIndexChunk[] } {
  return parseRuntimeJson(source, {
    schema: embeddingIndexSchema,
    schemaName: 'loop.embedding-index.v1',
    policy: 'freeze',
    expectedVersion: [1, 2],
    uniqueIdCollectionPath: ['chunks'],
  });
}

export function parseBoundaryLoopGapQueriesV1(source: string): GapQueriesFile {
  return parseRuntimeJson(source, {
    schema: gapQueriesSchema,
    schemaName: 'loop.gap-queries.v1',
    policy: 'freeze',
    expectedVersion: 1,
    uniqueCollections: [{ path: ['queries'], key: 'query' }],
  });
}

export function parseBoundaryLoopGapEventV1(source: string): GapEventLine {
  return parseRuntimeJson(source, {
    schema: gapEventSchema,
    schemaName: 'loop.gap-event.v1',
    policy: 'freeze',
  });
}

export function parseBoundaryLoopLearnQueueV1(source: string): { queries: LearnGapQueryEntry[] } {
  return parseRuntimeJson(source, {
    schema: z.object({
      version: z.literal(1),
      updatedAt: timestampSchema.optional(),
      queries: z.array(learnGapQuerySchema).max(100_000),
    }).strict().transform(({ queries }) => ({ queries })),
    schemaName: 'loop.learn-queue.v1',
    policy: 'freeze',
    expectedVersion: 1,
    uniqueCollections: [{ path: ['queries'], key: 'query' }],
  });
}

export function parseBoundaryLoopGraphV1(source: string): LoopGraph {
  return parseRuntimeJson(source, {
    schema: loopGraphSchema,
    schemaName: 'loop.graph.v1',
    policy: 'freeze',
    expectedVersion: 1,
    uniqueCollections: [
      { path: ['nodes'], key: 'id' },
      { path: ['edges'], key: 'id' },
    ],
  });
}

export function parseBoundaryLoopCursorsV1(source: string): CursorStore {
  return parseRuntimeJson(source, {
    schema: cursorStoreSchema,
    schemaName: 'loop.cursors.v1',
    policy: 'freeze',
  });
}

export function parseBoundaryLoopLedgerLineV1(source: string): LoopLedgerEntry {
  return parseRuntimeJson(source, {
    schema: loopLedgerSchema,
    schemaName: 'loop.ledger-line.v1',
    policy: 'freeze',
  });
}
