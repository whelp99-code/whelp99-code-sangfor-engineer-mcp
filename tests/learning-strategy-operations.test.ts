import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrategyStoreManager } from '../packages/sangfor-learning-strategy/src/store.js';
import {
  LearningStrategyService,
  type LearningFactQueryRequest,
  type ResearchStrategyRequest,
  type StrategyListItem,
  type StrategyListRequest,
  type ValidateStrategyRequest,
} from '../packages/sangfor-learning-strategy/src/service.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function service(): LearningStrategyService {
  const root = mkdtempSync(join(tmpdir(), 'strategy-ops-'));
  roots.push(root);
  return new LearningStrategyService(root);
}

const DIGEST = 'a'.repeat(64);

function researchRequest(strategyId: string, firmwareVersion: string): ResearchStrategyRequest {
  return {
    strategyId, vendor: 'SANGFOR',
    scope: { product: 'ENDPOINT_SECURE', firmwareVersion },
    registryDigest: DIGEST, versionTruthRecord: 'truth-604',
    officialCitation: 'https://support.example.invalid/manual', pageVerified: true,
  };
}

describe('learning-strategy listing', () => {
  it('pages exact matches through an opaque cursor without repeating or dropping a revision', async () => {
    // Given: three researched revisions in the same exact scope.
    const subject = service();
    for (const strategyId of ['alpha', 'bravo', 'charlie']) await subject.research(researchRequest(strategyId, '6.0.4'));
    const request: StrategyListRequest = { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4', limit: 2 };
    // When: the caller walks the result set with limit 2.
    const first = subject.list(request);
    const second = subject.list({ ...request, cursor: first.nextCursor });
    // Then: the two pages partition the set exactly once and the walk terminates.
    const seen: StrategyListItem[] = [...first.items, ...second.items];
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set(seen.map((item) => item.revisionId)).size).toBe(3);
    expect(seen.map((item) => item.strategyId).sort()).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('refuses a malformed cursor instead of restarting the walk from the top', async () => {
    // Given: a store with one listable revision.
    const subject = service();
    await subject.research(researchRequest('alpha', '6.0.4'));
    // When: the cursor is not a base64url-encoded revision identifier.
    // Then: the walk fails closed rather than silently rewinding.
    expect(() => subject.list({ cursor: 'not*a*cursor' })).toThrow('INVALID_CURSOR');
  });

  it('refuses a well-formed cursor that no longer identifies the current result set', async () => {
    // Given: a cursor minted from a revision outside the filtered set.
    const subject = service();
    const created = await subject.research(researchRequest('alpha', '6.0.4'));
    const stale = Buffer.from(created.revision.revisionId, 'utf8').toString('base64url');
    // When: that cursor is replayed against a different filter.
    // Then: the service refuses instead of returning a page from a foreign set.
    expect(() => subject.list({ firmwareVersion: '9.9.9', cursor: stale }))
      .toThrow('INVALID_CURSOR: cursor does not identify the current result set.');
  });

  it('rejects a limit outside 1..100 and an unknown filter field', () => {
    // Given: a service with no revisions.
    const subject = service();
    // When/Then: both boundary violations fail closed with the documented codes.
    expect(() => subject.list({ limit: 0 })).toThrow('INVALID_INPUT: limit must be 1..100.');
    expect(() => subject.list({ limit: 101 })).toThrow('INVALID_INPUT: limit must be 1..100.');
    expect(() => subject.list({ region: 'apac' } as never)).toThrow('UNKNOWN_FIELD: $.region');
  });
});

describe('learning-strategy authoring', () => {
  it('refuses a citation that is not an HTTPS page-verified source', async () => {
    // Given: a research request whose citation was never page-verified.
    const subject = service();
    const request = { ...researchRequest('alpha', '6.0.4'), pageVerified: false };
    // When/Then: authoring fails closed before any store file is created.
    await expect(subject.research(request)).rejects.toThrow('OFFICIAL_SOURCE_REQUIRED');
    expect(subject.list().items).toEqual([]);
  });

  it('refuses a registry digest that is not lowercase SHA-256', async () => {
    // Given: an uppercase digest.
    const subject = service();
    const request = { ...researchRequest('alpha', '6.0.4'), registryDigest: 'A'.repeat(64) };
    // When/Then: the exact-identity contract is enforced at the boundary.
    await expect(subject.research(request)).rejects.toThrow('INVALID_INPUT: registryDigest must be lowercase SHA-256.');
  });

  it('reports a capture-evidence gap while still persisting the draft', async () => {
    // Given: a research request with no capture evidence file.
    const subject = service();
    // When: the draft is authored.
    const created = await subject.research(researchRequest('alpha', '6.0.4'));
    // Then: the gap is reported and the benchmark refuses to claim capture evidence.
    expect(created.evidenceGaps).toEqual(['capture evidence is not supplied']);
    expect(created.benchmark).toEqual({ officialSource: true, captureEvidence: false });
    expect(created.revision.state).toBe('draft');
  });

  it('fails with the exact store error when a committed draft cannot be reloaded', async () => {
    // Given: persistence succeeds but the post-commit reload reports no store.
    const subject = service();
    const originalLoad = StrategyStoreManager.prototype.load;
    let calls = 0;
    vi.spyOn(StrategyStoreManager.prototype, 'load').mockImplementation(function (this: StrategyStoreManager) {
      calls += 1;
      return calls === 3 ? null : originalLoad.call(this);
    });
    // When/Then: research fails closed at the typed nullable boundary.
    await expect(subject.research(researchRequest('alpha', '6.0.4')))
      .rejects.toThrow(/^STORE_UNAVAILABLE: committed strategy could not be reloaded\.$/u);
  });

  it('fails with the exact revision error when a committed store has no revision', async () => {
    // Given: the post-commit reload is readable but contains no revisions.
    const subject = service();
    const originalLoad = StrategyStoreManager.prototype.load;
    let calls = 0;
    vi.spyOn(StrategyStoreManager.prototype, 'load').mockImplementation(function (this: StrategyStoreManager) {
      calls += 1;
      const loaded = originalLoad.call(this);
      return calls === 3 && loaded ? { ...loaded, generations: [] } : loaded;
    });
    // When/Then: research refuses instead of manufacturing a revision result.
    await expect(subject.research(researchRequest('alpha', '6.0.4')))
      .rejects.toThrow(/^REVISION_NOT_FOUND: committed strategy has no revision\.$/u);
  });

  it('derives distinct content hashes for distinct scopes and reuses one for an identical request', async () => {
    // Given: two different firmware scopes and a repeat of the first.
    const subject = service();
    const first = await subject.research(researchRequest('alpha', '6.0.4'));
    const other = await subject.research(researchRequest('bravo', '6.0.5'));
    const repeat = await subject.research(researchRequest('alpha', '6.0.4'));
    // When: the persisted content hashes are compared.
    // Then: the hash tracks request content, not revision identity.
    expect(first.revision.contentHash).not.toBe(other.revision.contentHash);
    expect(repeat.revision.contentHash).toBe(first.revision.contentHash);
    expect(repeat.revision.revisionId).not.toBe(first.revision.revisionId);
  });
});

describe('learning-strategy validation', () => {
  it('requires an exact revision and reports the evidence gap without inventing next states', async () => {
    // Given: a draft revision authored without capture evidence.
    const subject = service();
    const created = await subject.research(researchRequest('alpha', '6.0.4'));
    const request: ValidateStrategyRequest = { strategyId: 'alpha', revisionId: created.revision.revisionId };
    // When: the revision is validated with no evidence file supplied.
    const result = subject.validate(request);
    // Then: it is invalid, offers no transition, and a wrong identity is refused outright.
    expect(result).toMatchObject({ valid: false, errors: ['EVIDENCE_REQUIRED'], eligibleNextStates: [] });
    expect(() => subject.validate({ strategyId: 'alpha', revisionId: 'missing' })).toThrow('REVISION_NOT_FOUND');
    expect(() => subject.validate({ strategyId: 'absent', revisionId: created.revision.revisionId })).toThrow('STORE_UNAVAILABLE');
  });

  it('offers the lifecycle-permitted next states once evidence is present', async () => {
    // Given: a draft revision carrying a capture evidence file.
    const subject = service();
    const created = await subject.research({ ...researchRequest('alpha', '6.0.4'), captureEvidenceFile: 'approval.json' });
    // When: it is validated.
    const result = subject.validate({ strategyId: 'alpha', revisionId: created.revision.revisionId });
    // Then: exactly the transitions the lifecycle table allows from `draft` are offered.
    expect(result.valid).toBe(true);
    expect([...result.eligibleNextStates].sort()).toEqual(['deprecated', 'researched', 'stale']);
  });

  it('reports an evidence digest that is not lowercase SHA-256 as an error, not a throw', async () => {
    // Given: a validation request with a malformed digest.
    const subject = service();
    const created = await subject.research({ ...researchRequest('alpha', '6.0.4'), captureEvidenceFile: 'approval.json' });
    // When: the revision is validated.
    const result = subject.validate({
      strategyId: 'alpha', revisionId: created.revision.revisionId, evidenceDigest: 'zz',
    });
    // Then: the caller receives a typed error list and no eligible transition.
    expect(result).toMatchObject({ valid: false, errors: ['EVIDENCE_DIGEST_INVALID'], eligibleNextStates: [] });
  });
});

describe('learning-strategy fact collection', () => {
  it('maps every resolver refusal to its non-exact resolution and marks all facts ineligible', async () => {
    // Given: a store whose only revision is a draft in one exact scope.
    const subject = service();
    await subject.research(researchRequest('alpha', '6.0.4'));
    const request: LearningFactQueryRequest = {
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' },
      context: { registryDigest: 'b'.repeat(64), versionTruthRecord: 'truth-604', environment: 'lab' },
      factIds: ['version', 'buildId'],
    };
    // When: facts are collected under a drifted digest and then under an exact one.
    const drift = subject.collectFacts(request);
    const noStrategy = subject.collectFacts({
      ...request, context: { registryDigest: DIGEST, versionTruthRecord: 'truth-604', environment: 'lab' },
    });
    // Then: the refusal is surfaced as a resolution, never as a partial fact value.
    expect(drift.resolution).toBe('blocked');
    expect(noStrategy.resolution).toBe('research_required');
    expect(drift.observations.map((item) => item.reason)).toEqual(['REGISTRY_DRIFT', 'REGISTRY_DRIFT']);
    expect(drift.observations.every((item) => item.eligibility === 'ineligible' && item.value === undefined)).toBe(true);
    expect(drift.coverage).toEqual({ requested: 2, complete: 0, partial: 0, conflict: 0, unavailable: 2 });
    expect(drift.evidenceFiles).toEqual([]);
    expect(drift.runRef).not.toBe(noStrategy.runRef);
  });

  it('refuses an empty or non-string fact id list before touching the resolver', () => {
    // Given: a service with no revisions at all.
    const subject = service();
    const scope = { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' };
    const context = { registryDigest: DIGEST, versionTruthRecord: 'truth-604' };
    // When/Then: the fact id contract is enforced at the boundary.
    expect(() => subject.collectFacts({ scope, context, factIds: [] }))
      .toThrow('INVALID_INPUT: factIds must be a non-empty string array.');
    expect(() => subject.collectFacts({ scope, context, factIds: [''] }))
      .toThrow('INVALID_INPUT: factIds must be a non-empty string array.');
    expect(() => subject.collectFacts({ scope, context, factIds: [7] as never }))
      .toThrow('INVALID_INPUT: factIds must be a non-empty string array.');
  });

  it('rejects a credential field nested anywhere inside the query', () => {
    // Given: a query whose context smuggles a credential.
    const subject = service();
    // When/Then: the recursive guard refuses before resolution.
    expect(() => subject.collectFacts({
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' },
      context: { registryDigest: DIGEST, versionTruthRecord: 'truth', token: 'x' } as never,
      factIds: ['version'],
    })).toThrow('SECRET_FIELD_FORBIDDEN: $.context.token');
  });
});

describe('learning-strategy store enumeration', () => {
  it('refuses to serve a listing when any store file on the root is corrupt', async () => {
    // Given: a root holding one good store and one unparseable one.
    const root = mkdtempSync(join(tmpdir(), 'strategy-corrupt-'));
    roots.push(root);
    const subject = new LearningStrategyService(root);
    await subject.research(researchRequest('alpha', '6.0.4'));
    writeFileSync(join(root, 'zz-broken.json'), '{ not json', { mode: 0o600 });
    // When/Then: enumeration preserves the boundary parser's fail-closed error.
    expect(() => subject.list()).toThrow('RUNTIME_SCHEMA_INVALID: learning-strategy.store.v1');
  });

  it('returns an empty page rather than throwing when the root does not exist yet', () => {
    // Given: a root path that was never created.
    const parent = mkdtempSync(join(tmpdir(), 'strategy-absent-'));
    roots.push(parent);
    const root = join(parent, 'never-created');
    // When: a listing is requested.
    // Then: the empty state is a valid answer, not a failure.
    expect(new LearningStrategyService(root).list()).toEqual({ items: [] });
  });

  it('rejects a strategy id that could escape the store root', () => {
    // Given: a traversal-shaped strategy id.
    const subject = service();
    // When/Then: path construction refuses before any file is opened.
    expect(() => subject.validate({ strategyId: '../escape', revisionId: 'x' }))
      .toThrow('INVALID_INPUT: strategyId is invalid.');
  });
});
