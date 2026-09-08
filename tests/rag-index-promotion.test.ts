import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { evaluateIndexPromotion, sealIndexPromotionReport } from '../packages/sangfor-rag/src/index-promotion-evaluator.js';
import { CandidateSearchUnavailableError, IndexPromotionRouter } from '../packages/sangfor-rag/src/index-promotion-router.js';
import type { HnswIndexIdentity, IndexPromotionReportInput, PromotionCurrentState, PromotionSearchPort } from '../packages/sangfor-rag/src/index-promotion-types.js';
import { parsePgvectorScope } from '../packages/sangfor-rag/src/pgvector-schema.js';
import { hashEmbedding } from '../packages/sangfor-rag/src/hash-embedding.js';

const measuredAt = '2026-08-27T12:00:00.000Z';
const now = new Date('2026-08-27T12:05:00.000Z');
const scope = parsePgvectorScope({ tenantId: 'tenant-a', projectId: 'project-a', actorId: 'actor-a' });
const identity: HnswIndexIdentity = {
  oid: '12345', relfilenode: '67890', definitionDigest: 'e'.repeat(64),
  name: 'BlroRagEmbedding_embedding_hnsw_idx', tableName: 'BlroRagEmbedding',
  operatorClass: 'vector_cosine_ops', valid: true as const, ready: true as const,
};
const current: PromotionCurrentState = {
  tenantId: scope.tenantId, projectId: scope.projectId, cohortId: 'cohort-a', indexEpoch: 34,
  corpusDigest: 'a'.repeat(64), extensionName: 'vector', extensionVersion: '0.8.1', indexName: 'BlroRagEmbedding_embedding_hnsw_idx',
  indexIdentity: 'd'.repeat(64), candidateRowCount: 210,
};

function input(overrides: Partial<IndexPromotionReportInput> = {}): IndexPromotionReportInput {
  return {
    schemaVersion: 'rag.index-promotion/1', tenantId: current.tenantId, projectId: current.projectId,
    cohortId: current.cohortId, indexEpoch: current.indexEpoch, corpusDigest: current.corpusDigest,
    exactResultDigest: 'b'.repeat(64), candidateResultDigest: 'c'.repeat(64),
    extensionName: current.extensionName, extensionVersion: current.extensionVersion,
    indexName: current.indexName, indexIdentity: current.indexIdentity, measuredAt, maxAgeSeconds: 3600,
    recallAtK: 0.99, exactP95Ms: 120, candidateP95Ms: 95, recoveryRate: 1, updateRate: 1,
    scopeIsolationProof: true, candidateRowCount: current.candidateRowCount, ...overrides,
  };
}

function report(overrides: Partial<IndexPromotionReportInput> = {}) {
  return sealIndexPromotionReport(input(overrides));
}

function port(options: { readonly promotion?: unknown | null; readonly preflight?: boolean; readonly candidateFailure?: Error; readonly malformed?: boolean } = {}): PromotionSearchPort {
  return {
    loadPromotion: vi.fn(async () => options.promotion === undefined ? report() : options.promotion),
    readCurrentState: vi.fn(async () => current),
    preflightCandidate: vi.fn(async () => options.preflight === false ? null : identity),
    searchExact: vi.fn(async () => [{ id: 'exact', text: 'exact', title: 'exact', sourceRef: 'exact', distance: 0 }]),
    searchCandidate: vi.fn(async (_input, expectedIdentity) => {
      if (expectedIdentity.oid !== identity.oid) throw new Error('identity mismatch');
      if (options.candidateFailure) throw options.candidateFailure;
      if (options.malformed) return [{ id: 'candidate' }];
      return [{ id: 'candidate', text: 'candidate', title: 'candidate', sourceRef: 'candidate', distance: 0 }];
    }),
  };
}

const query = { scope, query: hashEmbedding('oracle'), filters: {}, limit: 5 };

describe('index promotion evaluator', () => {
  it.each([
    ['absolute latency threshold', { exactP95Ms: 140, candidateP95Ms: 100 }],
    ['relative latency threshold', { exactP95Ms: 100, candidateP95Ms: 80 }],
  ])('promotes at the %s', (_name, values) => {
    expect(evaluateIndexPromotion(report(values), current, now)).toEqual({ eligible: true, reason: 'PROMOTION_ELIGIBLE' });
  });

  it.each([
    ['PROMOTION_RECALL_LOW', { recallAtK: 0.989 }],
    ['PROMOTION_LATENCY_HIGH', { exactP95Ms: 100, candidateP95Ms: 100.01 }],
    ['PROMOTION_RECOVERY_FAILED', { recoveryRate: 0.99 }],
    ['PROMOTION_UPDATE_FAILED', { updateRate: 0.99 }],
    ['PROMOTION_SCOPE_ISOLATION_FAILED', { scopeIsolationProof: false }],
    ['PROMOTION_REPORT_STALE', { measuredAt: '2026-08-27T10:00:00.000Z', maxAgeSeconds: 60 }],
    ['PROMOTION_CORPUS_MISMATCH', { corpusDigest: 'e'.repeat(64) }],
    ['PROMOTION_SCOPE_MISMATCH', { projectId: 'project-b' }],
    ['PROMOTION_EXTENSION_UNSUPPORTED', { extensionVersion: '0.8.0' }],
    ['PROMOTION_INDEX_MISMATCH', { indexIdentity: 'f'.repeat(64) }],
  ])('refuses %s', (reason, values) => {
    expect(evaluateIndexPromotion(report(values), current, now)).toEqual({ eligible: false, reason });
  });

  it('refuses report digest tampering and malformed or nonfinite values', () => {
    expect(evaluateIndexPromotion({ ...report(), recallAtK: 0.5 }, current, now)).toEqual({ eligible: false, reason: 'PROMOTION_REPORT_DIGEST_MISMATCH' });
    expect(() => sealIndexPromotionReport(input({ candidateP95Ms: Number.NaN }))).toThrow(/PROMOTION_REPORT_INVALID/u);
  });
});

describe('diagnostic promotion search router', () => {
  it('uses exact explicitly without loading promotion', async () => {
    const search = port();
    const result = await new IndexPromotionRouter(search).search(query, { backend: 'exact', now });
    expect(result.backend).toBe('exact');
    expect(result.diagnostics.reason).toBe('EXACT_REQUESTED');
    expect(search.loadPromotion).not.toHaveBeenCalled();
  });

  it('uses exact with visible diagnostics when no report exists', async () => {
    const result = await new IndexPromotionRouter(port({ promotion: null })).search(query, { backend: 'auto', now });
    expect(result.backend).toBe('exact');
    expect(result.diagnostics.reason).toBe('PROMOTION_NOT_FOUND');
  });

  it('uses exact with visible diagnostics for malformed persisted state', async () => {
    const result = await new IndexPromotionRouter(port({ promotion: { schemaVersion: 'broken' } })).search(query, { backend: 'auto', now });
    expect(result.backend).toBe('exact');
    expect(result.diagnostics.reason).toBe('PROMOTION_REPORT_INVALID');
  });

  it('falls back visibly before dispatch when the named index is missing', async () => {
    const search = port({ preflight: false });
    const result = await new IndexPromotionRouter(search).search(query, { backend: 'auto', now });
    expect(result.backend).toBe('exact');
    expect(result.diagnostics.reason).toBe('CANDIDATE_PREFLIGHT_UNAVAILABLE');
    expect(search.searchCandidate).not.toHaveBeenCalled();
  });

  it('returns only candidate rows after the barrier and verified candidate postcheck', async () => {
    const search = port();
    const barrier = vi.fn(async () => undefined);
    const result = await new IndexPromotionRouter(search).search(query, { backend: 'auto', now, beforeCandidateDispatch: barrier });
    expect(result.backend).toBe('hnsw');
    expect(result.hits.map((hit) => hit.id)).toEqual(['candidate']);
    expect(result.diagnostics.reason).toBe('PROMOTION_VALID');
    expect(barrier).toHaveBeenCalledTimes(1);
    expect(search.searchCandidate).toHaveBeenCalledWith(query, identity);
  });

  it.each([
    ['mid-query error', { candidateFailure: new Error('timeout') }],
    ['partial decode', { malformed: true }],
  ])('returns typed unavailable without exact fallback or mixing on %s', async (_name, options) => {
    const search = port(options);
    await expect(new IndexPromotionRouter(search).search(query, { backend: 'auto', now })).rejects.toBeInstanceOf(CandidateSearchUnavailableError);
    expect(search.searchExact).not.toHaveBeenCalled();
    expect(search.searchCandidate).toHaveBeenCalledTimes(1);
  });
});

describe('index promotion owner CLI boundary', () => {
  it('provides help and strictly refuses unsupported input before database access', () => {
    const cli = 'scripts/rag-index-promotion.ts';
    const help = spawnSync('pnpm', ['exec', 'tsx', cli, '--help'], { encoding: 'utf8' });
    const bad = spawnSync('pnpm', ['exec', 'tsx', cli, '--unknown'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--apply');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('RAG_INDEX_PROMOTION_ARGUMENT_UNSUPPORTED');
  });
});
