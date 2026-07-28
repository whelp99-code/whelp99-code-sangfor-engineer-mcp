import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoData } from '@sangfor/shared';
import { promoteLearningApproval, type LearningApprovalEvent, type LearningApprovalPayload } from './approval.js';
import { FactService, type FactQueryResult as LegacyFactResult } from './fact-service.js';
import { getTransitionRequirements, isValidTransition } from './lifecycle.js';
import type { MethodResult } from './methods.js';
import { resolveExactStrategy, type ResolverContext, type ResolverError, type StrategyScope } from './resolver.js';
import { StrategyStoreManager, type StrategyRevision, type StrategyState, type StrategyStore } from './store.js';

const SECRET_FIELD = /^(?:username|password|token|cookie|authorization|secret|apiKey)$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function assertSafeLearningInput(value: unknown, allowedKeys?: readonly string[], path = '$', seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`INVALID_INPUT: ${path} must be an object.`);
  if (seen.has(value as object)) throw new Error('INVALID_INPUT: cyclic input is forbidden.');
  seen.add(value as object);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(key)) throw new Error(`SECRET_FIELD_FORBIDDEN: ${path}.${key}`);
    if (allowedKeys && !allowedKeys.includes(key)) throw new Error(`UNKNOWN_FIELD: ${path}.${key}`);
    if (child && typeof child === 'object') {
      if (Array.isArray(child)) {
        for (const [index, item] of child.entries()) {
          if (item && typeof item === 'object') assertSafeLearningInput(item, undefined, `${path}.${key}[${index}]`, seen);
        }
      } else assertSafeLearningInput(child, undefined, `${path}.${key}`, seen);
    }
  }
  seen.delete(value as object);
}

export interface StrategyListRequest {
  strategyId?: string;
  vendor?: 'SANGFOR' | 'FORTINET' | 'CISCO';
  product?: string;
  firmwareVersion?: string;
  status?: StrategyState;
  cursor?: string;
  limit?: number;
}

export interface StrategyListItem {
  strategyId: string;
  revisionId: string;
  vendor?: 'SANGFOR' | 'FORTINET' | 'CISCO';
  product: string;
  firmwareVersion: string;
  status: StrategyState;
  createdAt: string;
}

export interface ResearchStrategyRequest {
  strategyId: string;
  vendor: 'SANGFOR' | 'FORTINET' | 'CISCO';
  scope: StrategyScope;
  registryDigest: string;
  versionTruthRecord: string;
  productVariant?: string;
  officialCitation: string;
  pageVerified: boolean;
  captureEvidenceFile?: string;
  methods?: StrategyRevision['methods'];
}

export interface ValidateStrategyRequest {
  strategyId: string;
  revisionId: string;
  evidenceFile?: string;
  evidenceDigest?: string;
}

export interface PromoteStrategyRequest extends ValidateStrategyRequest {
  toState: StrategyState;
  approvalPayload: LearningApprovalPayload;
  approvalToken: string;
  evidenceRoot: string;
}

export interface LearningFactQueryRequest {
  scope: StrategyScope;
  context: ResolverContext;
  factIds: string[];
  methodResults?: MethodResult[];
  allowCanary?: boolean;
}

export interface LearningFactObservation {
  factId: string;
  status: 'complete' | 'partial' | 'conflict' | 'unavailable';
  eligibility: 'eligible' | 'ineligible';
  value?: unknown;
  methodCode?: string;
  recipeRevisionId?: string;
  evidenceFile?: string;
  evidenceDigest?: string;
  conflictCandidates?: LegacyFactResult['conflictCandidates'];
  reason?: string;
}

function uniqueRevisions(store: StrategyStore): StrategyRevision[] {
  const byId = new Map<string, StrategyRevision>();
  for (const revision of store.generations.flatMap((generation) => generation.revisions)) byId.set(revision.revisionId, revision);
  return [...byId.values()];
}

function strategyPath(root: string, strategyId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(strategyId)) throw new Error('INVALID_INPUT: strategyId is invalid.');
  return join(root, `${strategyId}.json`);
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!/^[A-Za-z0-9-]{8,128}$/u.test(value)) throw new Error();
    return value;
  } catch { throw new Error('INVALID_CURSOR: cursor is malformed.'); }
}

export class LearningStrategyService {
  constructor(private readonly root = resolveRepoData('data/runtime/learning-strategies')) {}

  private stores(): Array<{ manager: StrategyStoreManager; store: StrategyStore }> {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const manager = new StrategyStoreManager(join(this.root, entry.name));
        const store = manager.load();
        if (!store) throw new Error(`STORE_CORRUPT: ${entry.name}`);
        return { manager, store };
      });
  }

  private revisions(): StrategyRevision[] {
    return this.stores().flatMap(({ store }) => uniqueRevisions(store));
  }

  list(request: StrategyListRequest = {}): { items: StrategyListItem[]; nextCursor?: string } {
    assertSafeLearningInput(request, ['strategyId', 'vendor', 'product', 'firmwareVersion', 'status', 'cursor', 'limit']);
    const limit: number = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_INPUT: limit must be 1..100.');
    const after = decodeCursor(request.cursor as string | undefined);
    const matches = this.revisions()
      .filter((revision): revision is StrategyRevision & { scope: StrategyScope } => revision.scope !== undefined)
      .filter((revision) => request.strategyId === undefined || revision.strategyId === request.strategyId)
      .filter((revision) => request.vendor === undefined || revision.vendor === request.vendor)
      .filter((revision) => request.product === undefined || revision.scope.product === request.product)
      .filter((revision) => request.firmwareVersion === undefined || revision.scope.firmwareVersion === request.firmwareVersion)
      .filter((revision) => request.status === undefined || revision.state === request.status)
      .sort((left, right) => left.revisionId.localeCompare(right.revisionId));
    const start = after === undefined ? 0 : matches.findIndex((revision) => revision.revisionId === after) + 1;
    if (after !== undefined && start === 0) throw new Error('INVALID_CURSOR: cursor does not identify the current result set.');
    const page = matches.slice(start, start + limit);
    const items = page.map((revision) => ({
      strategyId: revision.strategyId,
      revisionId: revision.revisionId,
      ...(revision.vendor === undefined ? {} : { vendor: revision.vendor }),
      product: revision.scope.product,
      firmwareVersion: revision.scope.firmwareVersion,
      status: revision.state,
      createdAt: revision.createdAt,
    }));
    const last = page.at(-1);
    return start + page.length < matches.length && last
      ? { items, nextCursor: Buffer.from(last.revisionId, 'utf8').toString('base64url') }
      : { items };
  }

  resolve(scope: StrategyScope, context: ResolverContext): ReturnType<typeof resolveExactStrategy> {
    assertSafeLearningInput(scope, ['product', 'firmwareVersion', 'capability', 'fact']);
    assertSafeLearningInput(context, ['registryDigest', 'versionTruthRecord', 'productVariant', 'deviceScope', 'environment']);
    return resolveExactStrategy(this.revisions(), scope, context);
  }

  research(request: ResearchStrategyRequest): { strategyId: string; revision: StrategyRevision; evidenceGaps: string[]; benchmark: { officialSource: boolean; captureEvidence: boolean } } {
    assertSafeLearningInput(request, ['strategyId', 'vendor', 'scope', 'registryDigest', 'versionTruthRecord', 'productVariant', 'officialCitation', 'pageVerified', 'captureEvidenceFile', 'methods']);
    if (!request.pageVerified || !/^https:\/\//u.test(request.officialCitation)) throw new Error('OFFICIAL_SOURCE_REQUIRED: an HTTPS page-verified citation is required.');
    if (!SHA256.test(request.registryDigest)) throw new Error('INVALID_INPUT: registryDigest must be lowercase SHA-256.');
    const manager = new StrategyStoreManager(strategyPath(this.root, request.strategyId));
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
    const committed = manager.commit(next, current.currentGeneration);
    if (!committed.ok) throw new Error(`STORE_COMMIT_FAILED: ${committed.error ?? 'unknown'}`);
    const revision = uniqueRevisions(manager.load()!).at(-1)!;
    return { strategyId: request.strategyId, revision, evidenceGaps, benchmark: { officialSource: true, captureEvidence: evidenceGaps.length === 0 } };
  }

  validate(request: ValidateStrategyRequest): { valid: boolean; revision: StrategyRevision; eligibleNextStates: StrategyState[]; errors: string[] } {
    assertSafeLearningInput(request, ['strategyId', 'revisionId', 'evidenceFile', 'evidenceDigest']);
    const manager = new StrategyStoreManager(strategyPath(this.root, request.strategyId));
    const store = manager.load();
    if (!store) throw new Error('STORE_UNAVAILABLE: strategy is missing or corrupt.');
    const revision = uniqueRevisions(store).find((candidate) => candidate.revisionId === request.revisionId);
    if (!revision) throw new Error('REVISION_NOT_FOUND: exact revision is required.');
    const errors: string[] = [];
    if (!request.evidenceFile && !revision.evidenceFile) errors.push('EVIDENCE_REQUIRED');
    if (request.evidenceDigest !== undefined && !SHA256.test(request.evidenceDigest)) errors.push('EVIDENCE_DIGEST_INVALID');
    const states: StrategyState[] = ['researched', 'lab_verified', 'device_verified', 'strategy_field_verified', 'stale', 'deprecated'];
    const eligibleNextStates = errors.length === 0 ? states.filter((state) => isValidTransition(revision.state, state)) : [];
    return { valid: errors.length === 0, revision, eligibleNextStates, errors };
  }

  promote(request: PromoteStrategyRequest): { revision: StrategyRevision; event: LearningApprovalEvent } {
    assertSafeLearningInput(request, ['strategyId', 'revisionId', 'evidenceFile', 'evidenceDigest', 'toState', 'approvalPayload', 'approvalToken', 'evidenceRoot']);
    const validation = this.validate({
      strategyId: request.strategyId,
      revisionId: request.revisionId,
      ...(request.evidenceFile === undefined ? {} : { evidenceFile: request.evidenceFile }),
      ...(request.evidenceDigest === undefined ? {} : { evidenceDigest: request.evidenceDigest }),
    });
    if (!validation.valid) throw new Error(`VALIDATION_FAILED: ${validation.errors.join(',')}`);
    if (!isValidTransition(validation.revision.state, request.toState)) throw new Error(`INVALID_TRANSITION: ${validation.revision.state} -> ${request.toState}`);
    if (request.approvalPayload.entityType !== 'strategy'
      || request.approvalPayload.entityId !== request.strategyId
      || request.approvalPayload.revisionId !== request.revisionId
      || request.approvalPayload.toState !== request.toState
      || request.approvalPayload.fromState !== validation.revision.state) {
      throw new Error('APPROVAL_BINDING_MISMATCH: approval must bind the exact strategy, revision, source state, and target state.');
    }
    const requirements = getTransitionRequirements(validation.revision.state, request.toState);
    if (!requirements?.requiresHumanHmac) throw new Error('APPROVAL_REQUIRED: transition is not configured for signed approval.');
    const manager = new StrategyStoreManager(strategyPath(this.root, request.strategyId));
    const store = manager.load();
    if (!store) throw new Error('STORE_UNAVAILABLE: strategy is missing or corrupt.');
    let event: LearningApprovalEvent | undefined;
    let promotedRevision: StrategyRevision | undefined;
    promoteLearningApproval({
      payload: request.approvalPayload,
      approvalToken: request.approvalToken,
      currentState: validation.revision.state,
      currentContentHash: validation.revision.contentHash,
      evidenceRoot: request.evidenceRoot,
      appendEvent: (value) => {
        const next = manager.addRevision(store, {
          ...validation.revision,
          state: request.toState,
          derivedFromRevisionId: validation.revision.revisionId,
          evidenceFile: request.approvalPayload.evidenceFile,
          evidenceDigest: request.approvalPayload.evidenceDigest,
          strategyId: request.strategyId,
          contentHash: validation.revision.contentHash,
        });
        next.lifecycleEvents = [...store.lifecycleEvents, value];
        const committed = manager.commit(next, store.currentGeneration);
        if (!committed.ok) throw new Error(`STORE_COMMIT_FAILED: ${committed.error ?? 'unknown'}`);
        event = value;
        promotedRevision = uniqueRevisions(manager.load()!).at(-1)!;
      },
    });
    return { revision: promotedRevision!, event: event! };
  }

  collectFacts(request: LearningFactQueryRequest): {
    resolution: 'exact' | 'canary_required' | 'research_required' | 'blocked' | 'ambiguous';
    observations: LearningFactObservation[];
    coverage: { requested: number; complete: number; partial: number; conflict: number; unavailable: number };
    runRef: string;
    evidenceFiles: string[];
  } {
    assertSafeLearningInput(request, ['scope', 'context', 'factIds', 'methodResults', 'allowCanary']);
    if (!Array.isArray(request.factIds) || request.factIds.length === 0 || request.factIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new Error('INVALID_INPUT: factIds must be a non-empty string array.');
    }
    const resolution = this.resolve(request.scope, request.context);
    if ('code' in resolution) {
      const mapped: Record<ResolverError['code'], 'canary_required' | 'research_required' | 'blocked' | 'ambiguous'> = {
        NEAR_VERSION_ONLY: 'canary_required', NO_ELIGIBLE_STRATEGY: 'research_required',
        REGISTRY_DRIFT: 'blocked', VERSION_TRUTH_MISMATCH: 'blocked', AMBIGUOUS_STRATEGY: 'ambiguous',
      };
      return {
        resolution: mapped[resolution.code],
        observations: request.factIds.map((factId) => ({ factId, status: 'unavailable', eligibility: 'ineligible', reason: resolution.code })),
        coverage: { requested: request.factIds.length, complete: 0, partial: 0, conflict: 0, unavailable: request.factIds.length },
        runRef: randomUUID(), evidenceFiles: [],
      };
    }
    const legacy = new FactService({ revisions: [resolution.revision], methodResults: request.methodResults }).query({
      scope: request.scope, factIds: request.factIds, context: request.context,
    });
    const observations: LearningFactObservation[] = legacy.map((item) => {
      if (item.status === 'conflict') return { factId: item.factId, status: 'conflict', eligibility: 'ineligible', conflictCandidates: item.conflictCandidates };
      if (item.status === 'complete') return { factId: item.factId, status: 'complete', eligibility: 'eligible', value: item.value, recipeRevisionId: item.revisionId, evidenceFile: item.evidenceFile, evidenceDigest: item.evidenceDigest };
      if (item.status === 'partial') return { factId: item.factId, status: 'partial', eligibility: 'ineligible', value: item.value, recipeRevisionId: item.revisionId };
      return { factId: item.factId, status: 'unavailable', eligibility: 'ineligible', reason: item.status };
    });
    const count = (status: LearningFactObservation['status']) => observations.filter((item) => item.status === status).length;
    return {
      resolution: 'exact', observations,
      coverage: { requested: observations.length, complete: count('complete'), partial: count('partial'), conflict: count('conflict'), unavailable: count('unavailable') },
      runRef: randomUUID(), evidenceFiles: [...new Set(observations.flatMap((item) => item.evidenceFile ? [item.evidenceFile] : []))],
    };
  }
}
