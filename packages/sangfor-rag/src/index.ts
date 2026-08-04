import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { KnowledgeChunk, ProductCode, normalizeProduct, nowId, resolveRepoData, withDirLock, writeFileAtomicSync } from '@sangfor/shared';
import { getEmbeddingProvider, resolveEmbeddingModelFromEnv, wasEmbeddingFallback } from './embedding-provider.js';
import { isMimoViaLitellm } from './litellm-config.js';
import type { EmbeddingBackend, EmbeddingProvider } from './embedding-provider-types.js';
import { createMimoRerankFromEnv } from './mimo-rerank-provider.js';
import { cosineSimilarity, hashEmbedding } from './hash-embedding.js';
import { computeBm25Scores } from './bm25.js';

export { hashEmbedding, cosineSimilarity } from './hash-embedding.js';
export { getEmbeddingProvider, resetEmbeddingProviderCache, wasEmbeddingFallback } from './embedding-provider.js';
export type { EmbeddingBackend, EmbeddingProvider, RerankProvider } from './embedding-provider-types.js';
export { computeBm25Scores, tokenize } from './bm25.js';

const require = createRequire(import.meta.url);
const DEFAULT_INDEX_PATH = resolveRepoData('data/rag/index.json', 'SANGFOR_RAG_INDEX_PATH');

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
  embeddingBackend?: EmbeddingBackend;
  embeddingModel?: string;
  vectorDims?: number;
}

export interface RagIndex {
  version: 1 | 2;
  chunks: RagDocumentChunk[];
  updatedAt: string;
}

export interface RagSearchInput {
  product?: string;
  version?: string;
  query: string;
  limit?: number;
  indexPath?: string;
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
}

let lastRagSearchDiagnostics: RagSearchDiagnostics = { degraded: false };

/** Diagnostics for the most recent ragSearch() call (not ragSearchSync — that path is hash-by-design, not a runtime degradation). */
export function getRagSearchDiagnostics(): RagSearchDiagnostics {
  return lastRagSearchDiagnostics;
}

function computeRagSearchDiagnostics(index: RagIndex, queryWasHashFallback: boolean): RagSearchDiagnostics {
  const reasons: string[] = [];
  const semanticChunks = index.chunks.filter((c) => (c.embeddingBackend ?? 'hash') !== 'hash').length;
  if (index.chunks.length > 0 && semanticChunks === 0) {
    reasons.push('RAG index is hash-only (no semantic embeddings ingested) — ranking is lexical/hashed, not semantic');
  }
  if (queryWasHashFallback) {
    reasons.push('query embedding fell back to the hash backend (configured semantic provider unavailable)');
  }
  return reasons.length > 0 ? { degraded: true, degradedReason: reasons.join('; ') } : { degraded: false };
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
    index = JSON.parse(raw) as RagIndex;
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

export function saveRagIndex(index: RagIndex, indexPath = DEFAULT_INDEX_PATH): void {
  const lockPath = `${indexPath}.lock`;
  withDirLock(lockPath, () => {
    const payload: RagIndex = { ...index, updatedAt: new Date().toISOString() };
    writeFileAtomicSync(indexPath, JSON.stringify(payload, null, 2));
    const stat = statSync(indexPath);
    ragIndexCache.set(indexPath, { mtimeMs: stat.mtimeMs, index: payload });
  });
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
  const vectors = await provider.embed(textChunks);
  const chunks = textChunks.map((chunkTextValue, index): RagDocumentChunk => {
    const contentHash = createHash('sha256').update(`${input.filePath}:${index}:${chunkTextValue}`).digest('hex');
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
  const index = loadRagIndex(indexPath);
  const existingHashes = new Set(index.chunks.map(chunk => chunk.contentHash));
  const newChunks = chunks.filter(chunk => !existingHashes.has(chunk.contentHash));
  if (newChunks.length === 0) {
    return { documentId, chunkCount: 0, indexPath, chunks: [], embeddingBackend: provider.name };
  }
  const hasSemantic = newChunks.some(c => c.embeddingBackend && c.embeddingBackend !== 'hash');
  index.version = hasSemantic ? 2 : index.version;
  index.chunks.push(...newChunks);
  saveRagIndex(index, indexPath);
  return { documentId, chunkCount: newChunks.length, indexPath, chunks: newChunks, embeddingBackend: provider.name };
}

export async function ragSearch(input: RagSearchInput): Promise<RagSearchHit[]> {
  const index = loadRagIndex(input.indexPath);
  const product = input.product ? normalizeProduct(input.product) : undefined;
  const provider = await getEmbeddingProvider();
  const [queryVector] = await provider.embed([input.query]);
  const candidateLimit = Number(process.env.SANGFOR_MIMO_RERANK_CANDIDATES ?? 40);
  const finalLimit = input.limit ?? 8;

  const allowCustomer = process.env.SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER === '1';
  const filtered = index.chunks
    .filter(chunk => !product || chunk.product === product)
    .filter(chunk => !input.version || !chunk.version || chunk.version === input.version)
    .filter(chunk => allowCustomer || chunk.trustLevel !== 'customer');

  lastRagSearchDiagnostics = computeRagSearchDiagnostics(index, wasEmbeddingFallback());

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
