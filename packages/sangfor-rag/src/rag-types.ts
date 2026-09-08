import type { AuthorizationResult } from '@sangfor/identity';
import type { KnowledgeChunk } from '@sangfor/shared';
import type { EmbeddingBackend } from './embedding-provider-types.js';

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

export interface RagSearchInput {
  product?: string;
  version?: string;
  sourceType?: KnowledgeChunk['sourceType'];
  trustLevel?: KnowledgeChunk['trustLevel'];
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
