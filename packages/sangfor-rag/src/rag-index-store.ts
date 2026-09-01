import { readFileSync, statSync } from 'node:fs';
import { resolveRepoData } from '@sangfor/shared';
import type { StoredRagIndex } from './runtime-boundary-codecs.js';
import type { RagDocumentChunk, RagIndex } from './rag-types.js';

export const DEFAULT_INDEX_PATH = resolveRepoData('data/rag/index.json', 'SANGFOR_RAG_INDEX_PATH');

export function assertLocalRagAuthorityAllowed(_indexPath?: string): void {
  if (process.env.SANGFOR_BLRO_AUTHORITY_STORE === 'postgres') {
    throw new Error('JM_LOCAL_RAG_INDEX_SUPERSEDED: use BlroAuthorityStore');
  }
}

export type StoredRagChunk = Omit<RagDocumentChunk, 'vector'> & {
  readonly vector?: number[];
  readonly vectorB64?: string;
};

export function encodeVectorB64(vector: number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

function decodeVectorB64(value: string): number[] {
  const buffer = Buffer.from(value, 'base64');
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return Array.from(new Float32Array(copy));
}

function hydrateStoredChunk(chunk: StoredRagChunk): RagDocumentChunk {
  if (Array.isArray(chunk.vector)) {
    const { vectorB64, ...rest } = chunk;
    return { ...rest, vector: chunk.vector };
  }
  const { vectorB64, ...rest } = chunk;
  return { ...rest, vector: vectorB64 ? decodeVectorB64(vectorB64) : [] };
}

export const ragIndexCache = new Map<string, { readonly mtimeMs: number; readonly index: RagIndex }>();

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function loadRagIndexWithParser(
  indexPath: string,
  parse: (source: string) => StoredRagIndex,
): RagIndex {
  assertLocalRagAuthorityAllowed(indexPath);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(indexPath);
  } catch (error) {
    if (isMissingFileError(error)) {
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
    if (isMissingFileError(error)) {
      ragIndexCache.delete(indexPath);
      return { version: 1, chunks: [], updatedAt: new Date().toISOString() };
    }
    throw error;
  }
  let index: RagIndex;
  try {
    const parsed = parse(raw);
    index = { ...parsed, chunks: parsed.chunks.map(hydrateStoredChunk) };
  } catch {
    throw new Error(`RAG_INDEX_CORRUPT: ${indexPath}`);
  }
  ragIndexCache.set(indexPath, { mtimeMs: stat.mtimeMs, index });
  return index;
}
