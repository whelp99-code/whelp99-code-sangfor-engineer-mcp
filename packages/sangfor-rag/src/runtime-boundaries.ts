import { parseRuntimeJson } from '../../shared/src/runtime-schema.js';
import type { RagDocumentChunk } from './rag-types.js';
import type { ShardedJsonlManifest } from './storage.js';
import {
  ragDocumentChunkRuntimeSchema,
  rerankResponseRuntimeSchema,
  shardedManifestRuntimeSchema,
  storedRagIndexRuntimeSchema,
  type StoredRagIndex,
} from './runtime-boundary-codecs.js';

export function parseBoundaryRagIndexV1(source: string): StoredRagIndex {
  return parseRuntimeJson(source, {
    schema: storedRagIndexRuntimeSchema,
    schemaName: 'rag.index.v1',
    policy: 'freeze',
    expectedVersion: [1, 2],
    uniqueIdCollectionPath: ['chunks'],
  });
}

export function parseBoundaryRagRerankResponseV1(source: string): { readonly ranked?: string[] } {
  return parseRuntimeJson(source, {
    schema: rerankResponseRuntimeSchema,
    schemaName: 'rag.rerank-response.v1',
    policy: 'INDETERMINATE',
  });
}

export function parseBoundaryRagShardManifestV1(source: string): ShardedJsonlManifest {
  return parseRuntimeJson(source, {
    schema: shardedManifestRuntimeSchema,
    schemaName: 'rag.shard-manifest.v1',
    policy: 'freeze',
    expectedVersion: 1,
    versionPath: ['schemaVersion'],
  });
}

export function parseBoundaryRagShardLineV1(source: string): RagDocumentChunk {
  return parseRuntimeJson(source, {
    schema: ragDocumentChunkRuntimeSchema,
    schemaName: 'rag.shard-line.v1',
    policy: 'freeze',
  });
}
