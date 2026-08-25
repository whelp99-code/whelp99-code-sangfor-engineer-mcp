/**
 * The closed set of reasons a competency report is refused.
 *
 * Every one of these used to be a silent skip, a silent dedupe, or a silently
 * shrinking denominator. Naming them as data is what lets a caller print WHY
 * there is no rate instead of printing a rate that is quietly wrong.
 */
export const COVERAGE_VIOLATION_KINDS = [
  'missingCatalog',
  'corruptFile',
  'schemaInvalid',
  'duplicateId',
  'unregisteredTool',
  'registryUnreachable',
  'missingCapabilityRef',
  'evidenceOutsideRoot',
  'evidenceNotRegularFile',
  'maturityBelowClaim',
] as const;

export type CoverageViolationKind = (typeof COVERAGE_VIOLATION_KINDS)[number];

export interface CoverageViolation {
  readonly kind: CoverageViolationKind;
  /** The atom the violation belongs to, or null for whole-file/catalog faults. */
  readonly atomId: string | null;
  readonly detail: string;
}

export const violation = (
  kind: CoverageViolationKind,
  atomId: string | null,
  detail: string,
): CoverageViolation => ({ kind, atomId, detail });

/** Thrown when a caller tries to build a coverage context without real grounding. */
export class CoverageContextError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`${field}: ${detail}`);
    this.name = 'CoverageContextError';
    this.field = field;
  }
}
