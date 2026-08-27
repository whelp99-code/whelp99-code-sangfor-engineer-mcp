import { createHash } from 'node:crypto';
import {
  REMOTE_SHADOW_OBSERVATION_VERSION,
  REMOTE_SHADOW_REPORT_VERSION,
  remoteShadowObservationSchema,
  type RemoteShadowFact,
  type RemoteShadowIssue,
  type RemoteShadowObservation,
  type RemoteShadowReport,
} from './remote-shadow-types.js';

export type * from './remote-shadow-types.js';

export type CompareRemoteShadowInput = {
  readonly local: RemoteShadowObservation;
  readonly remote: RemoteShadowObservation;
  readonly now: Date;
  readonly maxAgeMs: number;
};

export class RemoteShadowInputError extends Error {
  override readonly name = 'RemoteShadowInputError';
  constructor(readonly code: 'CLOCK_INVALID' | 'MAX_AGE_INVALID') {
    super(`REMOTE_SHADOW_INPUT_INVALID: ${code}`);
  }
}

export function parseRemoteShadowObservation(input: unknown): RemoteShadowObservation {
  return remoteShadowObservationSchema.parse(input);
}

export function compareRemoteShadow(input: CompareRemoteShadowInput): RemoteShadowReport {
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) throw new RemoteShadowInputError('CLOCK_INVALID');
  if (!Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs < 0) {
    throw new RemoteShadowInputError('MAX_AGE_INVALID');
  }

  const issues: RemoteShadowIssue[] = [];
  if (input.local.path !== 'local' || input.remote.path !== 'remote') issues.push({ kind: 'PATH_MISMATCH', side: 'both' });
  if (canonical(input.local.target) !== canonical(input.remote.target)) issues.push({ kind: 'TARGET_MISMATCH', side: 'both' });
  if (!input.local.readOnly) issues.push({ kind: 'READ_ONLY_REQUIRED', side: 'local' });
  if (!input.remote.readOnly) issues.push({ kind: 'READ_ONLY_REQUIRED', side: 'remote' });
  if (!authoritativePass(input.local)) issues.push({ kind: 'NON_AUTHORITATIVE_EXECUTION', side: 'local' });
  if (!authoritativePass(input.remote)) issues.push({ kind: 'NON_AUTHORITATIVE_EXECUTION', side: 'remote' });
  if (containsSecret(input.local)) issues.push({ kind: 'SECRET_BEARING_DATA', side: 'local' });
  if (containsSecret(input.remote)) issues.push({ kind: 'SECRET_BEARING_DATA', side: 'remote' });

  const localFacts = new Map(input.local.requiredFacts.map((fact) => [fact.key, fact]));
  const remoteFacts = new Map(input.remote.requiredFacts.map((fact) => [fact.key, fact]));
  const keys = [...new Set([...localFacts.keys(), ...remoteFacts.keys()])].sort();
  for (const key of keys) {
    const local = localFacts.get(key);
    const remote = remoteFacts.get(key);
    if (!local || !remote) {
      issues.push({ kind: 'FACT_SET_MISMATCH', side: local ? 'remote' : 'local', factKey: safeFactKey(key) });
      continue;
    }
    compareFact(local, remote, issues);
  }

  const freshness = { nowMs, maxAgeMs: input.maxAgeMs, issues };
  for (const fact of input.local.requiredFacts) checkFreshness(fact, 'local', freshness);
  for (const fact of input.remote.requiredFacts) checkFreshness(fact, 'remote', freshness);

  const sortedIssues = [...issues].sort((left, right) => canonical(left).localeCompare(canonical(right)));
  const localObservationDigest = digest(canonicalObservation(input.local));
  const remoteObservationDigest = digest(canonicalObservation(input.remote));
  const localProvenanceDigest = digest(canonicalProvenance(input.local));
  const remoteProvenanceDigest = digest(canonicalProvenance(input.remote));
  const verdict = sortedIssues.length === 0 ? 'PASS' : 'MISMATCH';
  const semanticReport = {
    schemaVersion: REMOTE_SHADOW_REPORT_VERSION,
    verdict,
    code: verdict === 'PASS' ? 'REMOTE_SHADOW_PASS' : 'REMOTE_SHADOW_MISMATCH',
    promotionEligible: verdict === 'PASS',
    comparedAt: input.now.toISOString(),
    maxAgeMs: input.maxAgeMs,
    factCount: keys.length,
    localObservationDigest,
    remoteObservationDigest,
    localProvenanceDigest,
    remoteProvenanceDigest,
    issues: sortedIssues,
  } as const;
  return {
    ...semanticReport,
    localAcquisition: acquisitionMetadata(input.local),
    remoteAcquisition: acquisitionMetadata(input.remote),
    localLatencyMs: totalLatency(input.local),
    remoteLatencyMs: totalLatency(input.remote),
    reportDigest: digest(canonical(semanticReport)),
  };
}

function compareFact(
  local: RemoteShadowFact,
  remote: RemoteShadowFact,
  issues: RemoteShadowIssue[],
): void {
  const factKey = safeFactKey(local.key);
  if (local.ordering !== remote.ordering) {
    issues.push({ kind: 'ORDERING_SCHEMA_MISMATCH', side: 'both', factKey });
  } else if (canonicalFactValue(local) !== canonicalFactValue(remote)) {
    issues.push({ kind: 'VALUE_MISMATCH', side: 'both', factKey });
  }
  if (canonical(semanticProvenance(local)) !== canonical(semanticProvenance(remote))) {
    issues.push({ kind: 'PROVENANCE_MISMATCH', side: 'both', factKey });
  }
}

type FreshnessContext = {
  readonly nowMs: number;
  readonly maxAgeMs: number;
  readonly issues: RemoteShadowIssue[];
};

function checkFreshness(
  fact: RemoteShadowFact,
  side: 'local' | 'remote',
  context: FreshnessContext,
): void {
  const collectedMs = Date.parse(fact.provenance.collectedAt);
  if (collectedMs > context.nowMs) context.issues.push({ kind: 'FUTURE_FACT', side, factKey: safeFactKey(fact.key) });
  else if (context.nowMs - collectedMs > context.maxAgeMs) context.issues.push({ kind: 'STALE_FACT', side, factKey: safeFactKey(fact.key) });
}

function authoritativePass(observation: RemoteShadowObservation): boolean {
  return observation.readOnly
    && observation.execution.status === 'PASS'
    && observation.execution.readBack?.status === 'PASS'
    && !observation.execution.mutationAttempted;
}

function canonicalObservation(observation: RemoteShadowObservation): string {
  return canonical({
    schemaVersion: REMOTE_SHADOW_OBSERVATION_VERSION,
    path: observation.path,
    target: observation.target,
    readOnly: observation.readOnly,
    execution: {
      schemaVersion: observation.execution.schemaVersion,
      status: observation.execution.status,
      mutationAttempted: observation.execution.mutationAttempted,
      readBack: observation.execution.readBack,
    },
    requiredFacts: [...observation.requiredFacts]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((fact) => ({
        key: fact.key,
        value: normalizedFactValue(fact),
        ordering: fact.ordering,
        provenance: semanticProvenance(fact),
      })),
  });
}

function canonicalProvenance(observation: RemoteShadowObservation): string {
  return canonical([...observation.requiredFacts]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((fact) => ({ key: fact.key, provenance: semanticProvenance(fact) })));
}

function semanticProvenance(fact: RemoteShadowFact): Readonly<Record<string, string>> {
  const provenance = fact.provenance;
  return {
    endpoint: provenance.endpoint,
    collector: provenance.collector,
    collectorVersion: provenance.collectorVersion,
    mapperVersion: provenance.mapperVersion,
    transport: provenance.transport,
    sourceIdentity: provenance.sourceIdentity,
    sourceScope: provenance.sourceScope,
  };
}

function canonicalFactValue(fact: RemoteShadowFact): string {
  return canonical(normalizedFactValue(fact));
}

function normalizedFactValue(fact: RemoteShadowFact): unknown {
  const normalized = normalizeMaps(fact.value);
  if (fact.ordering !== 'unordered' || !Array.isArray(normalized)) return normalized;
  return [...normalized].sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

function normalizeMaps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeMaps);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeMaps(child)]));
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(normalizeMaps(value));
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function acquisitionMetadata(observation: RemoteShadowObservation) {
  return [...observation.requiredFacts]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((fact) => ({
      factKey: safeFactKey(fact.key),
      collectedAt: fact.provenance.collectedAt,
      latencyMs: fact.provenance.latencyMs,
    }));
}

function totalLatency(observation: RemoteShadowObservation): number {
  return observation.requiredFacts.reduce((total, fact) => total + fact.provenance.latencyMs, 0);
}

const SECRET_KEY = /password|passwd|secret|token|authorization|cookie|session(?:id)?|api[_-]?key/iu;
const SECRET_VALUE = /(?:bearer|basic)\s+[a-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|token|secret|cookie)\s*[:=]/iu;

function containsSecret(value: unknown, key = ''): boolean {
  if (SECRET_KEY.test(key)) return true;
  if (typeof value === 'string') return SECRET_VALUE.test(value);
  if (Array.isArray(value)) return value.some((child) => containsSecret(child));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([childKey, child]) => containsSecret(child, childKey));
  }
  return false;
}

function safeFactKey(key: string): string {
  return SECRET_KEY.test(key) ? '***' : key;
}
