import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from '@sangfor/shared';
import type { RagIndex } from './rag-types.js';
import {
  parseBoundaryRagShardLineV1,
  parseBoundaryRagShardManifestV1,
} from './runtime-boundaries.js';

export interface RagIndexStore {
  readonly kind: 'json-file' | 'external';
  load(indexPath?: string): RagIndex;
  save(index: RagIndex, indexPath?: string): void;
}

export class JsonRagIndexStore implements RagIndexStore {
  readonly kind = 'json-file' as const;

  constructor(
    private readonly loadFn: (indexPath?: string) => RagIndex,
    private readonly saveFn: (index: RagIndex, indexPath?: string) => void,
  ) {}

  load(indexPath?: string): RagIndex {
    return this.loadFn(indexPath);
  }

  save(index: RagIndex, indexPath?: string): void {
    this.saveFn(index, indexPath);
  }
}

export interface StorageMigrationPlan {
  from: 'json-file';
  to: 'sharded-jsonl' | 'sqlite-vec' | 'lancedb';
  reason: string;
  requiresFreshBuild: boolean;
}

export function recommendStorageMigration(chunkCount: number, indexBytes?: number): StorageMigrationPlan | null {
  if (chunkCount < 50_000 && (indexBytes ?? 0) < 200_000_000) return null;
  return {
    from: 'json-file',
    to: 'sqlite-vec',
    reason: 'RAG index has crossed the JSON scan threshold; benchmark sqlite-vec against sharded JSONL and LanceDB before cutover.',
    requiresFreshBuild: true
  };
}

export interface ShardedJsonlManifest {
  schemaVersion: 1;
  source: 'rag-index-v2';
  updatedAt: string;
  chunkCount: number;
  shards: Array<{ product: string; file: string; chunkCount: number }>;
}

function shardFileName(product: string): string {
  return `${product.toLowerCase().replace(/[^a-z0-9_-]+/g, '_')}.jsonl`;
}

export function saveShardedJsonlIndex(index: RagIndex, outputDir: string): ShardedJsonlManifest {
  mkdirSync(outputDir, { recursive: true });
  const groups = new Map<string, typeof index.chunks>();
  for (const chunk of index.chunks) {
    const existing = groups.get(chunk.product) ?? [];
    existing.push(chunk);
    groups.set(chunk.product, existing);
  }
  const shards = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([product, chunks]) => {
    const file = shardFileName(product);
    const body = chunks.map((chunk) => JSON.stringify(chunk)).join('\n');
    writeFileAtomicSync(join(outputDir, file), `${body}\n`);
    return { product, file, chunkCount: chunks.length };
  });
  const manifest: ShardedJsonlManifest = {
    schemaVersion: 1,
    source: 'rag-index-v2',
    updatedAt: index.updatedAt,
    chunkCount: index.chunks.length,
    shards
  };
  writeFileAtomicSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function loadShardedJsonlIndex(inputDir: string): RagIndex {
  const manifestPath = join(inputDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Missing sharded RAG manifest: ${manifestPath}`);
  const manifest = parseBoundaryRagShardManifestV1(readFileSync(manifestPath, 'utf8'));
  const chunks = manifest.shards.flatMap((shard) => {
    const path = join(inputDir, shard.file);
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => parseBoundaryRagShardLineV1(line));
  });
  return {
    version: 2,
    updatedAt: manifest.updatedAt,
    chunks
  };
}

export function listShardedJsonlProducts(inputDir: string): string[] {
  if (!existsSync(inputDir)) return [];
  return readdirSync(inputDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.replace(/\.jsonl$/, '').toUpperCase())
    .sort();
}
