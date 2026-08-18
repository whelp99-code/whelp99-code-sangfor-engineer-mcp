/**
 * Deterministic adversarial verification of an engineer report (design 002, F4).
 *
 * Three checks run on every report before it is allowed to leave draft:
 * every RAG citation must resolve to a real chunk, every asserted fact must
 * match the snapshot it claims to come from, and every rollback target must
 * exist as a device object. A model that invents a citation, a fact or a
 * rollback handle produces a `draft-blocked` report, never a plausible one.
 *
 * The report shape is declared structurally here rather than imported, so this
 * check does not depend on the agent layer above it. Pure, no IO — the caller
 * injects the corpus, the snapshot and the device inventory.
 */

export interface VerifiableCitation {
  chunkId: string;
}

export interface VerifiableFact {
  key: string;
  value: unknown;
}

/** Minimal structural view of an EngineerReport — only what F4 inspects. */
export interface VerifiableReport {
  reportId: string;
  deviceId: string;
  citations: readonly VerifiableCitation[];
  facts: readonly VerifiableFact[];
  rollback?: { targets: readonly string[] };
}

export type VerificationCheckName = 'citation-exists' | 'fact-exists' | 'rollback-target-exists';

export interface VerificationCheck {
  check: VerificationCheckName;
  pass: boolean;
  detail: string;
}

export interface VerifyReportClaimsInput {
  report: VerifiableReport;
  ragChunkIds: ReadonlySet<string>;
  snapshotFacts: Record<string, unknown>;
  deviceObjects: ReadonlySet<string>;
}

export interface VerifyReportClaimsResult {
  reportId: string;
  status: 'verified' | 'draft-blocked';
  checks: VerificationCheck[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(source[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Structural equality: property order in a claimed fact is not a difference. */
function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

export function verifyReportClaims(input: VerifyReportClaimsInput): VerifyReportClaimsResult {
  const { report, ragChunkIds, snapshotFacts, deviceObjects } = input;
  const checks: VerificationCheck[] = [];

  for (const citation of report.citations) {
    const pass = ragChunkIds.has(citation.chunkId);
    checks.push({
      check: 'citation-exists',
      pass,
      detail: pass
        ? `citation "${citation.chunkId}" resolves to a retrieved chunk`
        : `citation "${citation.chunkId}" does not exist in the retrieved corpus`,
    });
  }

  for (const fact of report.facts) {
    if (!Object.hasOwn(snapshotFacts, fact.key)) {
      checks.push({
        check: 'fact-exists',
        pass: false,
        detail: `fact "${fact.key}" is absent from the snapshot`,
      });
      continue;
    }
    const observed = snapshotFacts[fact.key];
    const pass = sameValue(fact.value, observed);
    checks.push({
      check: 'fact-exists',
      pass,
      detail: pass
        ? `fact "${fact.key}" matches the snapshot`
        : `fact "${fact.key}" claims ${canonical(fact.value)} but the snapshot holds ${canonical(observed)}`,
    });
  }

  for (const target of report.rollback?.targets ?? []) {
    const pass = deviceObjects.has(target);
    checks.push({
      check: 'rollback-target-exists',
      pass,
      detail: pass
        ? `rollback target "${target}" exists on the device`
        : `rollback target "${target}" does not exist on the device`,
    });
  }

  return {
    reportId: report.reportId,
    status: checks.every((c) => c.pass) ? 'verified' : 'draft-blocked',
    checks,
  };
}
