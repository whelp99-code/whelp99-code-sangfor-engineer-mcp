import type {
  CapabilityEvidenceGroundingIssue,
  EvidenceValidationIssue,
} from '@sangfor/competency';
import type { RuntimeSchemaIssue } from '../../packages/shared/src/runtime-schema.js';

export type CapabilityEvidenceCliIssue = RuntimeSchemaIssue | CapabilityEvidenceGroundingIssue | EvidenceValidationIssue | {
  readonly code:
    | 'invalid_arguments' | 'manifest_unreadable' | 'manifest_too_large'
    | 'validation_context_unavailable' | 'validation_context_invalid' | 'validation_context_too_large'
    | 'promotion_unreadable' | 'promotion_store_unavailable'
    | 'campaign_output_invalid' | 'campaign_output_exists' | 'catalog_authority_invalid'
    | 'grounding_unavailable' | 'internal_error';
  readonly path: readonly (string | number)[];
};

export class CapabilityEvidenceCliError extends Error {
  readonly name = 'CapabilityEvidenceCliError';

  constructor(readonly issue: CapabilityEvidenceCliIssue) {
    super(`CAPABILITY_EVIDENCE_CLI_ERROR: ${issue.code}`);
  }
}

export function refusalOutcome(
  status: 'refused' | 'stale',
  message: 'CAPABILITY_EVIDENCE_SCHEMA_REFUSED' | 'CAPABILITY_EVIDENCE_REFUSED' | 'CAPABILITY_EVIDENCE_STALE' | 'CAPABILITY_PROMOTION_REFUSED',
  violations: readonly CapabilityEvidenceCliIssue[],
): string {
  return `${JSON.stringify({ status, message, violations })}\n`;
}
