import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { KnowledgeChunk, ProductCode, normalizeProduct, nowId, resolveRepoData, withDirLock, writeFileAtomicSync } from '@sangfor/shared';
import type { AuthorizationResult } from '@sangfor/identity';
import { embedForRole, getEmbeddingProvider, resolveEmbeddingModelFromEnv, wasEmbeddingFallback } from './embedding-provider.js';
import { isMimoViaLitellm } from './litellm-config.js';
import type { EmbeddingBackend, EmbeddingProvider } from './embedding-provider-types.js';
import { createMimoRerankFromEnv } from './mimo-rerank-provider.js';
import { cosineSimilarity, hashEmbedding } from './hash-embedding.js';
import { computeBm25Scores } from './bm25.js';

export { hashEmbedding, cosineSimilarity } from './hash-embedding.js';
export { getEmbeddingProvider, resetEmbeddingProviderCache, wasEmbeddingFallback } from './embedding-provider.js';
export type { EmbeddingBackend, EmbeddingProvider, RerankProvider } from './embedding-provider-types.js';
export { computeBm25Scores, tokenize } from './bm25.js';
export { extractDocumentBlocks, type DocumentBlock, type DocumentBlockType } from './document-ir.js';
export {
  JsonRagIndexStore,
  listShardedJsonlProducts,
  loadShardedJsonlIndex,
  recommendStorageMigration,
  saveShardedJsonlIndex,
  type RagIndexStore,
  type ShardedJsonlManifest,
  type StorageMigrationPlan
} from './storage.js';

const require = createRequire(import.meta.url);
const DEFAULT_INDEX_PATH = resolveRepoData('data/rag/index.json', 'SANGFOR_RAG_INDEX_PATH');

export function assertLocalRagAuthorityAllowed(_indexPath?: string): void {
  if (process.env.SANGFOR_BLRO_AUTHORITY_STORE === 'postgres') {
    throw new Error('JM_LOCAL_RAG_INDEX_SUPERSEDED: use BlroAuthorityStore');
  }
}

export interface IngestDocumentInput {
  filePath: string;
  product: string;
  version?: string;
  sourceType?: KnowledgeChunk['sourceType'];
  trustLevel?: KnowledgeChunk['trustLevel'];
  title?: string;
  indexPath?: string;
}

export interface RagDocumentChunk extends KnowledgeChunk {
  vector: number[];
  contentHash: string;
  filePath: string;
  /** Mandatory on BLRO-authoritative chunks. Optional only for reading the superseded v1 JM index. */
  tenantId?: string;
  /** Mandatory on BLRO-authoritative chunks. Unscoped legacy chunks are never eligible for scoped search. */
  projectId?: string;
  /** Empty means every authorized member of the project; otherwise actor ids are an additional allow-list. */
  aclActorIds?: string[];
  embeddingBackend?: EmbeddingBackend;
  embeddingModel?: string;
  vectorDims?: number;
}

export interface RagIndex {
  version: 1 | 2;
  chunks: RagDocumentChunk[];
  updatedAt: string;
}

/**
 * On-disk chunk shape. Vectors are stored as base64-encoded little-endian
 * float32 (`vectorB64`) instead of a JSON number array: 384 floats serialize
 * to ~2KB base64 vs ~9KB pretty-printed JSON, which cut the real index from
 * 16.5MB to ~4MB at 1,249 chunks. Legacy indexes with a plain `vector`
 * number[] load unchanged; in memory every chunk always carries `vector`.
 */
type StoredRagChunk = Omit<RagDocumentChunk, 'vector'> & { vector?: number[]; vectorB64?: string };

function encodeVectorB64(vector: number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

function decodeVectorB64(b64: string): number[] {
  const buf = Buffer.from(b64, 'base64');
  // Copy before viewing: Buffer.from() may return a view into Node's shared
  // pool at an offset that is not 4-byte aligned for Float32Array.
  const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return Array.from(f32);
}

function hydrateStoredChunk(chunk: StoredRagChunk): RagDocumentChunk {
  if (Array.isArray(chunk.vector)) {
    const { vectorB64, ...rest } = chunk;
    return { ...rest, vector: chunk.vector };
  }
  const { vectorB64, ...rest } = chunk;
  return { ...rest, vector: vectorB64 ? decodeVectorB64(vectorB64) : [] };
}

export interface RagSearchInput {
  product?: string;
  version?: string;
  query: string;
  limit?: number;
  indexPath?: string;
}

export type AuthorizedRagScope = Extract<AuthorizationResult, { readonly ok: true }>;

export interface ScopedRagSearchInput {
  readonly authorization: AuthorizationResult;
  readonly query: string;
  readonly chunks: readonly RagDocumentChunk[];
  readonly product?: string;
  readonly version?: string;
  readonly limit?: number;
  /** Test/telemetry seam invoked after ACL filtering and immediately before ranking. */
  readonly onCandidates?: (candidates: readonly RagDocumentChunk[]) => void;
}

export interface RagSearchHit extends RagDocumentChunk {
  /** Composite hybrid score = alpha*cosineNorm + (1-alpha)*bm25Norm (see SANGFOR_RAG_HYBRID_ALPHA). */
  score: number;
  /** Raw cosine similarity against the query vector, before hybrid normalization. */
  cosineScore: number;
  /** Raw BM25 lexical score against the query, before hybrid normalization. */
  keywordScore: number;
  rerankScore?: number;
}

export interface RagSearchDiagnostics {
  degraded: boolean;
  degradedReason?: string;
  queryBackend?: EmbeddingBackend;
  queryVectorDims?: number;
  indexVectorDims?: Record<string, number>;
  embeddingModelCounts?: Record<string, number>;
  vectorDimensionMismatches?: number;
  mixedEmbeddingModels?: boolean;
}

let lastRagSearchDiagnostics: RagSearchDiagnostics = { degraded: false };

/** Diagnostics for the most recent ragSearch() call (not ragSearchSync — that path is hash-by-design, not a runtime degradation). */
export function getRagSearchDiagnostics(): RagSearchDiagnostics {
  return lastRagSearchDiagnostics;
}

function countBy<T extends string | number>(items: readonly T[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = String(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function computeRagSearchDiagnostics(
  index: RagIndex,
  queryWasHashFallback: boolean,
  queryBackend?: EmbeddingBackend,
  queryVectorDims?: number,
): RagSearchDiagnostics {
  const reasons: string[] = [];
  const semanticChunks = index.chunks.filter((c) => (c.embeddingBackend ?? 'hash') !== 'hash').length;
  const indexVectorDims = countBy(index.chunks.map((chunk) => chunk.vectorDims ?? chunk.vector.length));
  const embeddingModelCounts = countBy(index.chunks.map((chunk) => chunk.embeddingModel ?? `${chunk.embeddingBackend ?? 'hash'}:unknown`));
  const vectorDimensionMismatches = typeof queryVectorDims === 'number'
    ? index.chunks.filter((chunk) => chunk.vector.length !== queryVectorDims).length
    : 0;
  const mixedEmbeddingModels = Object.keys(embeddingModelCounts).length > 1;
  if (index.chunks.length > 0 && semanticChunks === 0) {
    reasons.push('RAG index is hash-only (no semantic embeddings ingested) — ranking is lexical/hashed, not semantic');
  }
  if (queryWasHashFallback) {
    reasons.push('query embedding fell back to the hash backend (configured semantic provider unavailable)');
  }
  if (vectorDimensionMismatches > 0) {
    reasons.push(`${vectorDimensionMismatches} indexed chunks have vector dimensions that do not match the query vector`);
  }
  if (mixedEmbeddingModels) {
    reasons.push('RAG index contains mixed embedding model cohorts; semantic scores may be incomparable');
  }
  const base = {
    degraded: reasons.length > 0,
    queryBackend,
    queryVectorDims,
    indexVectorDims,
    embeddingModelCounts,
    vectorDimensionMismatches,
    mixedEmbeddingModels
  };
  return reasons.length > 0 ? { ...base, degradedReason: reasons.join('; ') } : base;
}

/**
 * Drop the (potentially large, 384+-float) embedding vector from a hit while
 * keeping every other field. Shared by callers that only want vector data
 * opt-in (e.g. the MCP rag_search tool's include_vectors flag) — this is the
 * one place the "strip the vector" decision lives so it can't drift per-caller.
 */
export function omitVectorFromHit<T extends { vector: number[] }>(hit: T): Omit<T, 'vector'> {
  const { vector, ...rest } = hit;
  return rest;
}

// Module-level cache keyed by indexPath, invalidated by statSync mtimeMs. The
// index is a single JSON file that can grow to several MB — re-parsing it on
// every search call (loadRagIndex is called once per ragSearch/ragSearchSync
// invocation) dominates latency at anything past a small corpus.
const ragIndexCache = new Map<string, { mtimeMs: number; index: RagIndex }>();

export function loadRagIndex(indexPath = DEFAULT_INDEX_PATH): RagIndex {
  assertLocalRagAuthorityAllowed(indexPath);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(indexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      ragIndexCache.delete(indexPath);
      return { version: 1, chunks: [], updatedAt: new Date().toISOString() };
    }
    throw error;
  }
  const cached = ragIndexCache.get(indexPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.index;

  let raw: string;
  try {
    raw = readFileSync(indexPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      ragIndexCache.delete(indexPath);
      return { version: 1, chunks: [], updatedAt: new Date().toISOString() };
    }
    throw error;
  }
  let index: RagIndex;
  try {
    const parsed = JSON.parse(raw) as Omit<RagIndex, 'chunks'> & { chunks: StoredRagChunk[] };
    index = { ...parsed, chunks: parsed.chunks.map(hydrateStoredChunk) };
  } catch {
    // Fail loud. A silent empty-index fallback here would look identical to
    // "nothing has been ingested yet" and quietly discard whatever was in the
    // corrupt file from every caller's perspective (search results, ingest
    // dedup, summaries) — the exact failure mode resolveRepoData's own
    // diagnostic comment warns against for missing data roots.
    throw new Error(`RAG_INDEX_CORRUPT: ${indexPath}`);
  }
  ragIndexCache.set(indexPath, { mtimeMs: stat.mtimeMs, index });
  return index;
}

function ragIndexLockPath(indexPath: string): string {
  return `${indexPath}.lock`;
}

// The actual write, with no locking of its own — callers that already hold
// the `${indexPath}.lock` mutex (e.g. ingestDocument's load-modify-save) call
// this directly instead of the public saveRagIndex, since withDirLock is not
// reentrant: acquiring the same lock twice from inside its own critical
// section would just wait out its own holder and throw DirLockTimeoutError.
function saveRagIndexUnlocked(index: RagIndex, indexPath: string): void {
  const payload: RagIndex = { ...index, updatedAt: new Date().toISOString() };
  // Compact JSON + base64-f32 vectors on disk (see StoredRagChunk); the cache
  // keeps the hydrated in-memory form so readers never see the stored shape.
  const stored = {
    ...payload,
    chunks: payload.chunks.map(({ vector, ...rest }): StoredRagChunk => ({ ...rest, vectorB64: encodeVectorB64(vector) })),
  };
  writeFileAtomicSync(indexPath, JSON.stringify(stored));
  const stat = statSync(indexPath);
  ragIndexCache.set(indexPath, { mtimeMs: stat.mtimeMs, index: payload });
}

export function saveRagIndex(index: RagIndex, indexPath = DEFAULT_INDEX_PATH): void {
  assertLocalRagAuthorityAllowed(indexPath);
  withDirLock(ragIndexLockPath(indexPath), () => saveRagIndexUnlocked(index, indexPath));
}

export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') return extractTextFromPdf(filePath);
  if (['.md', '.markdown', '.txt', '.html', '.htm'].includes(ext)) return readFileSync(filePath, 'utf8');
  if (ext === '.docx') return extractTextFromDocx(filePath);
  if (ext === '.pptx') return extractTextFromPptx(filePath);
  if (['.xlsx', '.xlsm'].includes(ext)) return extractTextFromXlsx(filePath);
  throw new Error(`Unsupported document type for ingestion: ${ext}`);
}

function unzipList(filePath: string): string[] {
  return execFileSync('unzip', ['-Z1', filePath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function unzipText(filePath: string, entry: string): string {
  return execFileSync('unzip', ['-p', filePath, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function xmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:w:p|a:p|p|row|si|table:table-row)>/gi, '\n')
      .replace(/<\/(?:w:tc|a:t|t|c)>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sortedOfficeEntries(entries: string[], pattern: RegExp): string[] {
  return entries
    .filter(entry => pattern.test(entry))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export async function extractTextFromDocx(filePath: string): Promise<string> {
  const entries = sortedOfficeEntries(
    unzipList(filePath),
    /^word\/(?:document|footnotes|endnotes|header\d+|footer\d+)\.xml$/i
  );
  const text = entries.map(entry => xmlToText(unzipText(filePath, entry))).filter(Boolean).join('\n\n');
  if (!text) throw new Error(`DOCX text extraction produced no text: ${filePath}`);
  return text;
}

export async function extractTextFromPptx(filePath: string): Promise<string> {
  const entries = sortedOfficeEntries(unzipList(filePath), /^ppt\/slides\/slide\d+\.xml$/i);
  const text = entries
    .map((entry, index) => {
      const slideText = xmlToText(unzipText(filePath, entry));
      return slideText ? `Slide ${index + 1}\n${slideText}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  if (!text) throw new Error(`PPTX text extraction produced no text: ${filePath}`);
  return text;
}

export async function extractTextFromXlsx(filePath: string): Promise<string> {
  const entries = unzipList(filePath);
  const workbookEntries = sortedOfficeEntries(
    entries,
    /^xl\/(?:sharedStrings|workbook|worksheets\/sheet\d+)\.xml$/i
  );
  const text = workbookEntries.map(entry => xmlToText(unzipText(filePath, entry))).filter(Boolean).join('\n\n');
  if (!text) throw new Error(`XLSX text extraction produced no text: ${filePath}`);
  return text;
}

export async function extractTextFromPdf(filePath: string): Promise<string> {
  try {
    const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string }>;
    const result = await pdfParse(readFileSync(filePath));
    if (result.text?.trim()) return result.text;
  } catch (error) {
    // Fallback below. This lets the project run even before pdf-parse native path is ready.
  }
  try {
    return execFileSync('pdftotext', [filePath, '-'], { encoding: 'utf8' });
  } catch (error) {
    const raw = readFileSync(filePath).toString('latin1');
    const rough = raw.replace(/[^\x09\x0a\x0d\x20-\x7E가-힣]/g, ' ');
    if (rough.trim().length < 100) throw new Error('PDF text extraction failed. Install pdf-parse dependency or poppler pdftotext.');
    return rough;
  }
}

export function chunkText(text: string, options: { maxChars?: number; overlapChars?: number } = {}): string[] {
  const maxChars = options.maxChars ?? 1400;
  const overlapChars = options.overlapChars ?? 180;
  const normalized = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + maxChars, normalized.length);
    let cut = end;
    const paragraphCut = normalized.lastIndexOf('\n\n', end);
    if (paragraphCut > start + Math.floor(maxChars * 0.55)) cut = paragraphCut;
    chunks.push(normalized.slice(start, cut).trim());
    if (cut >= normalized.length) break;
    start = Math.max(0, cut - overlapChars);
  }
  return chunks.filter(Boolean);
}

/**
 * Identity of an indexed chunk. Ingestion and re-embedding MUST derive it the same
 * way from the same chunk text, or re-embedding stops recognising the rows it is
 * meant to refresh and appends duplicates alongside the stale ones instead.
 */
export function ragChunkContentHash(filePath: string, chunkIndex: number, text: string): string {
  return createHash('sha256').update(`${filePath}:${chunkIndex}:${text}`).digest('hex');
}

function vectorForSearch(chunk: RagDocumentChunk, queryVector: number[]): number {
  if (chunk.vector.length === queryVector.length) return cosineSimilarity(queryVector, chunk.vector);
  return cosineSimilarity(queryVector, hashEmbedding(chunk.text, queryVector.length));
}

/** SANGFOR_RAG_HYBRID_ALPHA — weight on the cosine term; 0..1, default 0.5. Out-of-range or unparseable falls back to the default rather than erroring, since this only tunes ranking. */
function resolveHybridAlpha(): number {
  const raw = process.env.SANGFOR_RAG_HYBRID_ALPHA;
  if (raw === undefined || raw.trim() === '') return 0.5;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 0.5;
  return parsed;
}

/** Min-max normalize `v` against `values`'s range. All-equal (incl. empty/zero range) collapses to 0 — a flat dimension carries no ranking signal, so it must not be treated as "everyone maximally matched". Exported for direct unit testing (large-array RangeError regression). */
export function minMaxNormalizer(values: readonly number[]): (v: number) => number {
  if (values.length === 0) return () => 0;
  // Plain loop, not Math.min(...values)/Math.max(...values) — spreading a
  // large candidate array onto the call stack as arguments blows V8's
  // argument-count limit (RangeError: Maximum call stack size exceeded) well
  // before it blows any memory budget.
  let min = values[0];
  let max = values[0];
  for (let i = 1; i < values.length; i += 1) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range <= 1e-12) return () => 0;
  return (v: number) => (v - min) / range;
}

/**
 * Hybrid (BM25 + cosine) ranking. `candidates` must already be the
 * filter-passed set (product/version/trust-level) — BM25 IDF and both
 * min-max normalizations are computed over exactly this set, per the design:
 * "rare among what could actually match", not rare across the whole index.
 */
function rankHybrid<T extends RagDocumentChunk>(
  candidates: readonly T[],
  queryVector: number[],
  query: string,
): Array<T & { score: number; cosineScore: number; keywordScore: number }> {
  const alpha = resolveHybridAlpha();
  const cosineScores = candidates.map((chunk) => vectorForSearch(chunk, queryVector));
  const bm25Scores = computeBm25Scores(query, candidates);
  const keywordScores = candidates.map((chunk) => bm25Scores.get(chunk.id) ?? 0);
  const normalizeCosine = minMaxNormalizer(cosineScores);
  const normalizeKeyword = minMaxNormalizer(keywordScores);
  return candidates.map((chunk, i) => {
    const cosineScore = cosineScores[i];
    const keywordScore = keywordScores[i];
    const score = alpha * normalizeCosine(cosineScore) + (1 - alpha) * normalizeKeyword(keywordScore);
    return { ...chunk, score, cosineScore, keywordScore };
  });
}

function actualEmbeddingModelName(provider: EmbeddingProvider): string {
  if (provider.name === 'hash') return 'hash';
  const model = (provider as unknown as { model?: string }).model;
  return typeof model === 'string' && model.trim() ? model : resolveEmbeddingModelFromEnv();
}

export async function ingestDocument(input: IngestDocumentInput): Promise<{ documentId: string; chunkCount: number; indexPath: string; chunks: RagDocumentChunk[]; embeddingBackend: EmbeddingBackend }> {
  const product = normalizeProduct(input.product);
  const text = await extractTextFromFile(input.filePath);
  const title = input.title ?? basename(input.filePath);
  const sourceType = input.sourceType ?? 'manual';
  const trustLevel = input.trustLevel ?? (sourceType === 'manual' ? 'official' : 'internal');
  const documentId = nowId('doc');
  const textChunks = chunkText(text);
  const provider = await getEmbeddingProvider();
  const vectors = await embedForRole(provider, textChunks, 'document');
  const chunks = textChunks.map((chunkTextValue, index): RagDocumentChunk => {
    const contentHash = ragChunkContentHash(input.filePath, index, chunkTextValue);
    const vector = vectors[index] ?? hashEmbedding(chunkTextValue);
    return {
      id: `${documentId}_chunk_${index + 1}`,
      sourceType,
      product,
      version: input.version,
      title,
      section: `chunk-${index + 1}`,
      text: chunkTextValue,
      trustLevel,
      vector,
      contentHash,
      filePath: input.filePath,
      embeddingBackend: provider.name,
      // Record the model that was ACTUALLY used, not the env-configured target —
      // if the configured backend (rapid-mlx/litellm) fell back to hash mid-call,
      // provider.name is already 'hash' here and the metadata must say so too.
      embeddingModel: actualEmbeddingModelName(provider),
      vectorDims: vector.length
    };
  });
  const indexPath = input.indexPath ?? DEFAULT_INDEX_PATH;
  assertLocalRagAuthorityAllowed(indexPath);
  // Hold the same lock saveRagIndex uses across the whole load→dedupe→mutate→
  // save sequence — without it, two concurrent ingestDocument calls can both
  // load the pre-mutation index, each append their own chunks on top of that
  // stale snapshot, and whichever saves last silently discards the other's
  // chunks (last-writer-wins data loss, not a crash — the dangerous kind).
  const { newChunks } = withDirLock(ragIndexLockPath(indexPath), () => {
    const index = loadRagIndex(indexPath);
    const existingHashes = new Set(index.chunks.map(chunk => chunk.contentHash));
    const newChunks = chunks.filter(chunk => !existingHashes.has(chunk.contentHash));
    if (newChunks.length === 0) return { newChunks };
    const hasSemantic = newChunks.some(c => c.embeddingBackend && c.embeddingBackend !== 'hash');
    index.version = hasSemantic ? 2 : index.version;
    index.chunks.push(...newChunks);
    saveRagIndexUnlocked(index, indexPath); // NOT saveRagIndex — we already hold this lock
    return { newChunks };
  });
  if (newChunks.length === 0) {
    return { documentId, chunkCount: 0, indexPath, chunks: [], embeddingBackend: provider.name };
  }
  return { documentId, chunkCount: newChunks.length, indexPath, chunks: newChunks, embeddingBackend: provider.name };
}

export async function ingestDocumentsBatch(inputs: IngestDocumentInput[]): Promise<{
  documentCount: number;
  chunkCount: number;
  indexPath: string;
  embeddingBackend: EmbeddingBackend;
}> {
  if (inputs.length === 0) {
    return {
      documentCount: 0,
      chunkCount: 0,
      indexPath: DEFAULT_INDEX_PATH,
      embeddingBackend: 'hash'
    };
  }
  const indexPath = inputs[0].indexPath ?? DEFAULT_INDEX_PATH;
  if (inputs.some((input) => (input.indexPath ?? DEFAULT_INDEX_PATH) !== indexPath)) {
    throw new Error('BATCH_RAG_INDEX_PATH_MISMATCH');
  }
  assertLocalRagAuthorityAllowed(indexPath);
  const provider = await getEmbeddingProvider();
  const chunks: RagDocumentChunk[] = [];
  for (const input of inputs) {
    const text = await extractTextFromFile(input.filePath);
    const title = input.title ?? basename(input.filePath);
    const sourceType = input.sourceType ?? 'manual';
    const trustLevel = input.trustLevel ?? (sourceType === 'manual' ? 'official' : 'internal');
    const product = normalizeProduct(input.product);
    const textChunks = chunkText(text);
    const vectors = await provider.embed(textChunks);
    const documentId = nowId('doc');
    chunks.push(...textChunks.map((chunkTextValue, index): RagDocumentChunk => ({
      id: `${documentId}_chunk_${index + 1}`,
      sourceType,
      product,
      version: input.version,
      title,
      section: `chunk-${index + 1}`,
      text: chunkTextValue,
      trustLevel,
      vector: vectors[index] ?? hashEmbedding(chunkTextValue),
      contentHash: ragChunkContentHash(input.filePath, index, chunkTextValue),
      filePath: input.filePath,
      embeddingBackend: provider.name,
      embeddingModel: actualEmbeddingModelName(provider),
      vectorDims: (vectors[index] ?? hashEmbedding(chunkTextValue)).length
    })));
  }
  const { chunkCount } = withDirLock(ragIndexLockPath(indexPath), () => {
    const index = loadRagIndex(indexPath);
    const existingHashes = new Set(index.chunks.map((chunk) => chunk.contentHash));
    const newChunks = chunks.filter((chunk) => !existingHashes.has(chunk.contentHash));
    if (newChunks.length === 0) return { chunkCount: 0 };
    if (newChunks.some((chunk) => chunk.embeddingBackend !== 'hash')) index.version = 2;
    index.chunks.push(...newChunks);
    saveRagIndexUnlocked(index, indexPath);
    return { chunkCount: newChunks.length };
  });
  return {
    documentCount: inputs.length,
    chunkCount,
    indexPath,
    embeddingBackend: provider.name
  };
}

export async function ragSearch(input: RagSearchInput): Promise<RagSearchHit[]> {
  const index = loadRagIndex(input.indexPath);
  const product = input.product ? normalizeProduct(input.product) : undefined;
  const provider = await getEmbeddingProvider();
  const [queryVector] = await embedForRole(provider, [input.query], 'query');
  const candidateLimit = Number(process.env.SANGFOR_MIMO_RERANK_CANDIDATES ?? 40);
  const finalLimit = input.limit ?? 8;

  const allowCustomer = process.env.SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER === '1';
  const filtered = index.chunks
    .filter(chunk => !product || chunk.product === product)
    .filter(chunk => !input.version || !chunk.version || chunk.version === input.version)
    .filter(chunk => allowCustomer || chunk.trustLevel !== 'customer');

  lastRagSearchDiagnostics = computeRagSearchDiagnostics(index, wasEmbeddingFallback(), provider.name, queryVector.length);

  let pool = rankHybrid(filtered, queryVector, input.query)
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateLimit);

  const reranker = createMimoRerankFromEnv();
  if (reranker && pool.length > 1) {
    try {
      const rerankTimeoutMs = Number(process.env.SANGFOR_MIMO_RERANK_TIMEOUT_MS ?? '5000');
      const rankedIds = await Promise.race([
        reranker.rerank(
          input.query,
          pool.map(p => ({ id: p.id, text: p.text, title: p.title })),
          finalLimit
        ),
        new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('rerank-timeout')), rerankTimeoutMs))
      ]);
      const order = new Map(rankedIds.map((id, i) => [id, rankedIds.length - i]));
      pool = pool
        .filter(p => order.has(p.id))
        .sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0))
        .slice(0, finalLimit)
        .map((p, i) => ({ ...p, rerankScore: order.get(p.id) ?? i }));
      return pool;
    } catch {
      // fall through to vector-only ranking
    }
  }

  return pool.slice(0, finalLimit);
}

/**
 * BLRO scope filter. This is intentionally a separate operation from ranking:
 * callers can prove the candidate collection itself contains no foreign row.
 * Missing scope metadata is refused by exclusion, never treated as public.
 */
export function filterScopedRagCandidates(
  chunks: readonly RagDocumentChunk[],
  authorization: AuthorizationResult,
): RagDocumentChunk[] {
  if (!authorization.ok || authorization.scope.permission !== 'rag:read') {
    throw new Error('RAG_SCOPE_UNAUTHORIZED');
  }
  const scope = authorization.scope;
  return chunks.filter((chunk) =>
    chunk.tenantId === scope.tenantId
    && chunk.projectId === scope.projectId
    && (!chunk.aclActorIds || chunk.aclActorIds.length === 0 || chunk.aclActorIds.includes(scope.actorId))
  );
}

/** Scope-first local search used for migration QA and derived JM caches. */
export function ragSearchScopedSync(input: ScopedRagSearchInput): RagSearchHit[] {
  const product = input.product ? normalizeProduct(input.product) : undefined;
  const authorized = filterScopedRagCandidates(input.chunks, input.authorization)
    .filter((chunk) => !product || chunk.product === product)
    .filter((chunk) => !input.version || !chunk.version || chunk.version === input.version);
  input.onCandidates?.(authorized);
  return rankHybrid(authorized, hashEmbedding(input.query), input.query)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 8);
}

/** Hash-only sync search for tests without network. Still hybrid (BM25+cosine) — only the embedding backend is fixed to hash. */
export function ragSearchSync(input: RagSearchInput): RagSearchHit[] {
  const index = loadRagIndex(input.indexPath);
  const product = input.product ? normalizeProduct(input.product) : undefined;
  const queryVector = hashEmbedding(input.query);
  const filtered = index.chunks
    .filter(chunk => !product || chunk.product === product)
    .filter(chunk => !input.version || !chunk.version || chunk.version === input.version);
  return rankHybrid(filtered, queryVector, input.query)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 8);
}

export function exportRagIndexSummary(indexPath = DEFAULT_INDEX_PATH): Record<string, unknown> {
  const index = loadRagIndex(indexPath);
  const byProduct = index.chunks.reduce<Record<ProductCode, number>>((acc, chunk) => {
    acc[chunk.product] = (acc[chunk.product] ?? 0) + 1;
    return acc;
  }, {} as Record<ProductCode, number>);
  const embeddingBackendCounts = index.chunks.reduce<Record<string, number>>((acc, chunk) => {
    const key = chunk.embeddingBackend ?? 'hash';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const hashChunks = index.chunks.filter((chunk) => (chunk.embeddingBackend ?? 'hash') === 'hash').length;
  const semanticChunks = index.chunks.length - hashChunks;
  const hashRatio = index.chunks.length > 0 ? hashChunks / index.chunks.length : 0;
  return {
    indexPath,
    indexVersion: index.version ?? 1,
    chunkCount: index.chunks.length,
    byProduct,
    embeddingBackendCounts,
    hashChunks,
    semanticChunks,
    hashRatio,
    backends: embeddingBackendCounts,
    mimoRerankEnabled: process.env.SANGFOR_MIMO_RERANK_ENABLED !== '0'
      && (process.env.SANGFOR_ALLOW_CLOUD_RAG === '1' || isMimoViaLitellm()),
    updatedAt: index.updatedAt
  };
}
