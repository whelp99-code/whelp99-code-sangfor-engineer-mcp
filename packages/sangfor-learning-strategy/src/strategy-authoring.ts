import { createHash } from 'node:crypto';
import type { ResearchStrategyRequest, StrategyResearchResult } from './service-contracts.js';
import { strategyStoreManager, type StrategyStoreAccess, uniqueRevisions } from './strategy-store-access.js';

/** Authoring of the first `draft` revision from an official, page-verified source. */

const LOWERCASE_SHA256 = /^[a-f0-9]{64}$/u;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export async function researchStrategy(access: StrategyStoreAccess, request: ResearchStrategyRequest): Promise<StrategyResearchResult> {
  if (!request.pageVerified || !/^https:\/\//u.test(request.officialCitation)) throw new Error('OFFICIAL_SOURCE_REQUIRED: an HTTPS page-verified citation is required.');
  if (!LOWERCASE_SHA256.test(request.registryDigest)) throw new Error('INVALID_INPUT: registryDigest must be lowercase SHA-256.');
  const manager = strategyStoreManager(access, request.strategyId);
  const current = manager.load() ?? manager.createStrategy(request.strategyId);
  const evidenceGaps = request.captureEvidenceFile ? [] : ['capture evidence is not supplied'];
  const contentHash = sha256(canonicalJson(request));
  const next = manager.addRevision(current, {
    strategyId: request.strategyId,
    state: 'draft',
    contentHash,
    scope: structuredClone(request.scope),
    registryDigest: request.registryDigest,
    versionTruthRecord: request.versionTruthRecord,
    vendor: request.vendor,
    ...(request.productVariant === undefined ? {} : { productVariant: request.productVariant }),
    ...(request.captureEvidenceFile === undefined ? {} : { evidenceFile: request.captureEvidenceFile }),
    ...(request.methods === undefined ? {} : { methods: request.methods }),
  });
  const committed = await manager.commit(next, current.currentGeneration);
  if (!committed.ok) throw new Error(`STORE_COMMIT_FAILED: ${committed.error ?? 'unknown'}`);
  const committedStore = manager.load();
  if (!committedStore) throw new Error('STORE_UNAVAILABLE: committed strategy could not be reloaded.');
  const revision = uniqueRevisions(committedStore).at(-1);
  if (!revision) throw new Error('REVISION_NOT_FOUND: committed strategy has no revision.');
  return { strategyId: request.strategyId, revision, evidenceGaps, benchmark: { officialSource: true, captureEvidence: evidenceGaps.length === 0 } };
}
