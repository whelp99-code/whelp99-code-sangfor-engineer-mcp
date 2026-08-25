import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { parseRuntimeJson, type RuntimeSchemaContract } from '../../shared/src/runtime-schema.js';
import type { CoverageContext } from './context.js';
import {
  CAPABILITY_EVIDENCE_VERSION,
  O5_COUNTER_KEYS,
  capabilityEvidenceManifestSchema,
  type CapabilityEvidenceManifest,
} from './evidence-schema.js';
import {
  CAPABILITY_PROMOTION_VERSION,
  capabilityPromotionEnvelopeSchema,
  type CapabilityPromotionEnvelope,
} from './promotion-schema.js';
import type { WorkAtom } from './schema.js';

export type CapabilityEvidenceGrounding = {
  readonly atoms: readonly WorkAtom[];
  readonly context: CoverageContext;
};

export type CapabilityEvidenceGroundingIssue = {
  readonly code:
    | 'unknown_work_atom' | 'product_mismatch' | 'capability_mismatch' | 'tool_mismatch' | 'human_only_atom'
    | 'manifest_digest_mismatch' | 'target_mismatch' | 'counter_mismatch' | 'timestamp_order'
    | 'identity_role_conflict';
  readonly path: readonly (string | number)[];
};

export class CapabilityEvidenceGroundingError extends Error {
  readonly name = 'CapabilityEvidenceGroundingError';

  constructor(readonly issues: readonly CapabilityEvidenceGroundingIssue[]) {
    super(`CAPABILITY_EVIDENCE_GROUNDING_REFUSED: ${issues.map(({ code }) => code).join(',')}`);
  }
}

const PROMOTION_CONTRACT: RuntimeSchemaContract<
  CapabilityPromotionEnvelope,
  z.input<typeof capabilityPromotionEnvelopeSchema>
> = {
  schema: capabilityPromotionEnvelopeSchema,
  schemaName: 'capability-promotion.v1',
  policy: 'deny',
  expectedVersion: CAPABILITY_PROMOTION_VERSION,
  maxDepth: 8,
};

const MANIFEST_CONTRACT: RuntimeSchemaContract<
  CapabilityEvidenceManifest,
  z.input<typeof capabilityEvidenceManifestSchema>
> = {
  schema: capabilityEvidenceManifestSchema,
  schemaName: 'capability-evidence.v1',
  policy: 'invalid_report',
  expectedVersion: CAPABILITY_EVIDENCE_VERSION,
  maxDepth: 12,
  uniqueIdCollectionPath: ['runs'],
};

export function parseGroundedCapabilityEvidence(input: {
  readonly source: string;
  readonly grounding: CapabilityEvidenceGrounding;
}): CapabilityEvidenceManifest {
  const manifest = parseRuntimeJson(input.source, MANIFEST_CONTRACT);
  const target = manifest.target;
  const issues: CapabilityEvidenceGroundingIssue[] = [];
  if (!input.grounding.context.registeredTools.has(target.toolId)) {
    issues.push({ code: 'tool_mismatch', path: ['target', 'toolId'] });
  }
  if (!input.grounding.context.maturityByCapability.has(`${target.productId}::${target.capabilityId}`)) {
    issues.push({ code: 'capability_mismatch', path: ['target', 'capabilityId'] });
  }
  const atomsById = new Map(input.grounding.atoms.map((atom) => [atom.id, atom]));
  target.workAtomIds.forEach((atomId, index) => {
    const atom = atomsById.get(atomId);
    if (atom === undefined) {
      issues.push({ code: 'unknown_work_atom', path: ['target', 'workAtomIds', index] });
      return;
    }
    if (atom.product !== 'ALL' && atom.product !== target.productId) {
      issues.push({ code: 'product_mismatch', path: ['target', 'workAtomIds', index] });
    }
    if (atom.coveredBy !== target.toolId) {
      issues.push({ code: 'tool_mismatch', path: ['target', 'workAtomIds', index] });
    }
    if (atom.capabilityRef === undefined
      || atom.capabilityRef.product !== target.productId || atom.capabilityRef.capabilityId !== target.capabilityId) {
      issues.push({ code: 'capability_mismatch', path: ['target', 'workAtomIds', index] });
    }
    if (atom.automatability === 'human') {
      issues.push({ code: 'human_only_atom', path: ['target', 'workAtomIds', index] });
    }
  });
  if (issues.length > 0) throw new CapabilityEvidenceGroundingError(issues);
  return manifest;
}

export function parseGroundedCapabilityPromotion(input: {
  readonly manifestSource: string;
  readonly promotionSource: string;
  readonly grounding: CapabilityEvidenceGrounding;
}): CapabilityPromotionEnvelope {
  const manifest = parseGroundedCapabilityEvidence({ source: input.manifestSource, grounding: input.grounding });
  const promotion = parseRuntimeJson(input.promotionSource, PROMOTION_CONTRACT);
  const request = promotion.request;
  const issues: CapabilityEvidenceGroundingIssue[] = [];
  const digest = createHash('sha256').update(input.manifestSource, 'utf8').digest('hex');
  if (request.manifestId !== manifest.manifestId || request.manifestDigest !== digest) {
    issues.push({ code: 'manifest_digest_mismatch', path: ['request', 'manifestDigest'] });
  }
  const target = manifest.target;
  if (request.target.productId !== target.productId
    || request.target.capabilityId !== target.capabilityId
    || request.target.toolId !== target.toolId
    || request.target.workAtomIds.length !== target.workAtomIds.length
    || request.target.workAtomIds.some((id, index) => id !== target.workAtomIds[index])) {
    issues.push({ code: 'target_mismatch', path: ['request', 'target'] });
  }
  O5_COUNTER_KEYS.forEach((key) => {
    if (request.o5Counters[key] !== manifest.o5Counters[key]) {
      issues.push({ code: 'counter_mismatch', path: ['request', 'o5Counters', key] });
    }
  });
  if (Date.parse(request.requestedAt) < Date.parse(manifest.generatedAt)) {
    issues.push({ code: 'timestamp_order', path: ['request', 'requestedAt'] });
  }
  const executorIds = new Set(manifest.runs.map(({ executor }) => executor.actorId));
  const readerIds = new Set(manifest.runs.map(({ independentReadBack }) => independentReadBack.verifier.actorId));
  if (executorIds.has(request.requestedBy.actorId) || readerIds.has(request.requestedBy.actorId)
    || [...executorIds].some((id) => readerIds.has(id))) {
    issues.push({ code: 'identity_role_conflict', path: ['request', 'requestedBy'] });
  }
  const decision = promotion.decision;
  if (decision !== null && (executorIds.has(decision.reviewer.actorId) || readerIds.has(decision.reviewer.actorId))) {
    issues.push({ code: 'identity_role_conflict', path: ['decision', 'reviewer'] });
  }
  if (issues.length > 0) throw new CapabilityEvidenceGroundingError(issues);
  return promotion;
}
