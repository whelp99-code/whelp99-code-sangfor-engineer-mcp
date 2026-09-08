import { createHash } from 'node:crypto';
import { z } from 'zod';

const SourceTypeSchema = z.enum(['manual', 'wiki', 'lesson', 'pattern']);
const TrustLevelSchema = z.enum(['official', 'internal', 'draft', 'needs_review', 'customer']);
const ScopeSchema = z.object({
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  actorId: z.string().min(1)
}).strict();
const FiltersSchema = z.object({
  product: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  sourceType: SourceTypeSchema.optional(),
  trustLevel: TrustLevelSchema.optional()
}).strict();
const CohortSchema = z.object({
  backend: z.literal('hash'),
  model: z.literal('hash-v1'),
  dimensions: z.number().int().positive()
}).strict();
const ChunkSchema = z.object({
  id: z.string().min(1),
  product: z.string().min(1),
  version: z.string().min(1),
  sourceType: SourceTypeSchema,
  trustLevel: TrustLevelSchema,
  title: z.string().min(1),
  text: z.string().min(1),
  filePath: z.string().min(1),
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  aclActorIds: z.array(z.string().min(1)),
  embeddingBackend: z.string().min(1),
  embeddingModel: z.string().min(1),
  vectorDims: z.number().int().positive()
}).strict();
const QuerySchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  scope: ScopeSchema,
  filters: FiltersSchema,
  limit: z.number().int().positive(),
  expectedIds: z.array(z.string().min(1)),
  forbiddenIds: z.array(z.string().min(1))
}).strict();
const CorpusSchema = z.object({
  schemaVersion: z.literal('rag-project-completeness.v1'),
  corpusId: z.literal('project-completeness-v1'),
  corpusDigest: z.string().regex(/^[a-f0-9]{64}$/),
  cohort: CohortSchema,
  chunks: z.array(ChunkSchema).min(1),
  queries: z.array(QuerySchema).min(1)
}).strict();

export type BenchmarkChunk = z.infer<typeof ChunkSchema>;
export type BenchmarkQuery = z.infer<typeof QuerySchema>;
export type BenchmarkCorpus = z.infer<typeof CorpusSchema>;

export class BenchmarkRefusal extends Error {
  readonly name = 'BenchmarkRefusal';
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function corpusDigest(corpus: BenchmarkCorpus): string {
  const { corpusDigest: _storedDigest, ...stable } = corpus;
  return sha256(canonicalJson(stable));
}

function assertUniqueAndSorted(rows: readonly { readonly id: string }[], kind: string): void {
  const ids = rows.map((row) => row.id);
  if (new Set(ids).size !== ids.length) throw new BenchmarkRefusal('DUPLICATE_ID', `${kind} ids must be unique`);
  const sorted = [...ids].sort((left, right) => left.localeCompare(right));
  if (ids.some((id, index) => id !== sorted[index])) {
    throw new BenchmarkRefusal('CORPUS_ORDER_NONDETERMINISTIC', `${kind} ids must be lexicographically sorted`);
  }
}

export function parseBenchmarkCorpus(value: unknown): BenchmarkCorpus {
  const parsed = CorpusSchema.safeParse(value);
  if (!parsed.success) throw new BenchmarkRefusal('CORPUS_SCHEMA_INVALID', parsed.error.issues.map((issue) => issue.path.join('.')).join(', '));
  const corpus = parsed.data;
  assertUniqueAndSorted(corpus.chunks, 'chunk');
  assertUniqueAndSorted(corpus.queries, 'query');
  for (const query of corpus.queries) {
    if (new Set(query.expectedIds).size !== query.expectedIds.length || new Set(query.forbiddenIds).size !== query.forbiddenIds.length) {
      throw new BenchmarkRefusal('DUPLICATE_ID', `query ${query.id} truth ids must be unique`);
    }
  }
  if (corpus.chunks.some((chunk) => chunk.vectorDims !== corpus.cohort.dimensions)) {
    throw new BenchmarkRefusal('EMBEDDING_DIMENSIONS_MISMATCH', 'every chunk must use the declared dimensions');
  }
  const cohorts = new Set(corpus.chunks.map((chunk) => `${chunk.embeddingBackend}\0${chunk.embeddingModel}`));
  if (cohorts.size !== 1 || corpus.chunks.some((chunk) => chunk.embeddingBackend !== corpus.cohort.backend || chunk.embeddingModel !== corpus.cohort.model)) {
    throw new BenchmarkRefusal('MIXED_EMBEDDING_COHORT', 'every chunk must use the declared backend and model');
  }
  const actualDigest = corpusDigest(corpus);
  if (actualDigest !== corpus.corpusDigest) throw new BenchmarkRefusal('CORPUS_DIGEST_DRIFT', `expected ${corpus.corpusDigest}, received ${actualDigest}`);
  return corpus;
}
