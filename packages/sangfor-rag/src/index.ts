import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { KnowledgeChunk, ProductCode, normalizeProduct, nowId } from '@sangfor/shared';
import { getEmbeddingProvider, resolveEmbeddingModelFromEnv } from './embedding-provider.js';
import { isMimoViaLitellm } from './litellm-config.js';
import type { EmbeddingBackend } from './embedding-provider-types.js';
import { createMimoRerankFromEnv } from './mimo-rerank-provider.js';
import { cosineSimilarity, hashEmbedding } from './hash-embedding.js';

export { hashEmbedding, cosineSimilarity } from './hash-embedding.js';
export { getEmbeddingProvider, resetEmbeddingProviderCache } from './embedding-provider.js';
export type { EmbeddingBackend, EmbeddingProvider, RerankProvider } from './embedding-provider-types.js';

const require = createRequire(import.meta.url);
const DEFAULT_INDEX_PATH = 'data/rag/index.json';

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
  score: number;
  rerankScore?: number;
}

function ensureParent(path: string): void {
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
}

export function loadRagIndex(indexPath = DEFAULT_INDEX_PATH): RagIndex {
  if (!existsSync(indexPath)) return { version: 1, chunks: [], updatedAt: new Date().toISOString() };
  return JSON.parse(readFileSync(indexPath, 'utf8')) as RagIndex;
}

export function saveRagIndex(index: RagIndex, indexPath = DEFAULT_INDEX_PATH): void {
  ensureParent(indexPath);
  const tmpPath = `${indexPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ ...index, updatedAt: new Date().toISOString() }, null, 2));
  renameSync(tmpPath, indexPath);
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
      embeddingModel: resolveEmbeddingModelFromEnv(),
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
  let pool = index.chunks
    .filter(chunk => !product || chunk.product === product)
    .filter(chunk => !input.version || !chunk.version || chunk.version === input.version)
    .filter(chunk => allowCustomer || chunk.trustLevel !== 'customer')
    .map(chunk => ({ ...chunk, score: vectorForSearch(chunk, queryVector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateLimit);

  const reranker = createMimoRerankFromEnv();
  if (reranker && pool.length > 1) {
    try {
      const rankedIds = await reranker.rerank(
        input.query,
        pool.map(p => ({ id: p.id, text: p.text, title: p.title })),
        finalLimit
      );
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

/** Hash-only sync search for tests without network. */
export function ragSearchSync(input: RagSearchInput): RagSearchHit[] {
  const index = loadRagIndex(input.indexPath);
  const product = input.product ? normalizeProduct(input.product) : undefined;
  const queryVector = hashEmbedding(input.query);
  return index.chunks
    .filter(chunk => !product || chunk.product === product)
    .filter(chunk => !input.version || !chunk.version || chunk.version === input.version)
    .map(chunk => ({ ...chunk, score: vectorForSearch(chunk, queryVector) }))
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
  return {
    indexPath,
    indexVersion: index.version ?? 1,
    chunkCount: index.chunks.length,
    byProduct,
    embeddingBackendCounts,
    mimoRerankEnabled: process.env.SANGFOR_MIMO_RERANK_ENABLED !== '0'
      && (process.env.SANGFOR_ALLOW_CLOUD_RAG === '1' || isMimoViaLitellm()),
    updatedAt: index.updatedAt
  };
}
