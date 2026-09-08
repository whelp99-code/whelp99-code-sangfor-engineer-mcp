import type { LearningApprovalEvent, LearningApprovalPayload } from './approval.js';
import type { FactQueryResult as LegacyFactResult } from './fact-service.js';
import type { MethodResult } from './methods.js';
import type { ResolverContext, StrategyScope } from './resolver.js';
import type { StrategyRevision, StrategyState } from './store.js';

/** The request and result shapes of every `LearningStrategyService` operation. */

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

export interface StrategyListPage {
  items: StrategyListItem[];
  nextCursor?: string;
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

export interface StrategyResearchResult {
  strategyId: string;
  revision: StrategyRevision;
  evidenceGaps: string[];
  benchmark: { officialSource: boolean; captureEvidence: boolean };
}

export interface ValidateStrategyRequest {
  strategyId: string;
  revisionId: string;
  evidenceFile?: string;
  evidenceDigest?: string;
}

export interface StrategyValidation {
  valid: boolean;
  revision: StrategyRevision;
  eligibleNextStates: StrategyState[];
  errors: string[];
}

export interface PromoteStrategyRequest extends ValidateStrategyRequest {
  toState: StrategyState;
  approvalPayload: LearningApprovalPayload;
  approvalToken: string;
  evidenceRoot: string;
}

export interface StrategyPromotion {
  revision: StrategyRevision;
  event: LearningApprovalEvent;
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

export interface LearningFactCollection {
  resolution: 'exact' | 'canary_required' | 'research_required' | 'blocked' | 'ambiguous';
  observations: LearningFactObservation[];
  coverage: { requested: number; complete: number; partial: number; conflict: number; unavailable: number };
  runRef: string;
  evidenceFiles: string[];
}
