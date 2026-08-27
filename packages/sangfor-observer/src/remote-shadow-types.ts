import { z } from 'zod';
import { browserExecutionResultSchema } from '@sangfor/browser-contracts';

export const REMOTE_SHADOW_OBSERVATION_VERSION = 'remote-shadow-observation.v1';
export const REMOTE_SHADOW_REPORT_VERSION = 'remote-shadow-report.v1';

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const jsonValue = z.unknown().superRefine((value, context) => {
  if (!isDeterministicJson(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'value must be finite deterministic JSON' });
  }
});

const provenanceSchema = z.object({
  endpoint: nonEmpty,
  collectedAt: z.string().datetime({ offset: true }),
  collector: nonEmpty,
  collectorVersion: nonEmpty,
  mapperVersion: nonEmpty,
  transport: z.enum(['api', 'browser', 'remote-mtls']),
  sourceIdentity: nonEmpty,
  sourceScope: nonEmpty,
  latencyMs: z.number().finite().nonnegative(),
}).strict();

const requiredFactSchema = z.object({
  key: nonEmpty,
  value: jsonValue,
  ordering: z.enum(['ordered', 'unordered']),
  provenance: provenanceSchema,
}).strict().superRefine((fact, context) => {
  if (fact.ordering === 'unordered' && !Array.isArray(fact.value) && !isJsonObject(fact.value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['ordering'], message: 'unordered requires an array or map value' });
  }
});

const targetSchema = z.object({
  tenantId: nonEmpty,
  projectId: nonEmpty,
  installationId: nonEmpty,
  deviceBindingDigest: sha256,
  origin: nonEmpty.url(),
  sourceScope: nonEmpty,
  sourceVersion: nonEmpty,
}).strict().superRefine((target, context) => {
  try {
    const url = new URL(target.origin);
    if (url.origin !== target.origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['origin'], message: 'origin must contain only scheme, host, and port' });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['origin'], message: 'origin must be absolute' });
  }
});

export const remoteShadowObservationSchema = z.object({
  schemaVersion: z.literal(REMOTE_SHADOW_OBSERVATION_VERSION),
  path: z.enum(['local', 'remote']),
  target: targetSchema,
  readOnly: z.boolean(),
  execution: browserExecutionResultSchema,
  requiredFacts: z.array(requiredFactSchema).min(1),
}).strict().superRefine((observation, context) => {
  const seen = new Set<string>();
  for (const [index, fact] of observation.requiredFacts.entries()) {
    if (seen.has(fact.key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['requiredFacts', index, 'key'], message: 'duplicate required fact key' });
    }
    seen.add(fact.key);
  }
});

export type RemoteShadowObservation = z.infer<typeof remoteShadowObservationSchema>;
export type RemoteShadowFact = RemoteShadowObservation['requiredFacts'][number];

export const REMOTE_SHADOW_ISSUE_KINDS = [
  'PATH_MISMATCH',
  'TARGET_MISMATCH',
  'READ_ONLY_REQUIRED',
  'NON_AUTHORITATIVE_EXECUTION',
  'FACT_SET_MISMATCH',
  'ORDERING_SCHEMA_MISMATCH',
  'VALUE_MISMATCH',
  'PROVENANCE_MISMATCH',
  'STALE_FACT',
  'FUTURE_FACT',
  'SECRET_BEARING_DATA',
] as const;
export type RemoteShadowIssueKind = (typeof REMOTE_SHADOW_ISSUE_KINDS)[number];

export type RemoteShadowIssue = {
  readonly kind: RemoteShadowIssueKind;
  readonly side?: 'local' | 'remote' | 'both';
  readonly factKey?: string;
};

export type RemoteShadowAcquisition = {
  readonly factKey: string;
  readonly collectedAt: string;
  readonly latencyMs: number;
};

export type RemoteShadowReport = {
  readonly schemaVersion: typeof REMOTE_SHADOW_REPORT_VERSION;
  readonly verdict: 'PASS' | 'MISMATCH';
  readonly code: 'REMOTE_SHADOW_PASS' | 'REMOTE_SHADOW_MISMATCH';
  readonly promotionEligible: boolean;
  readonly comparedAt: string;
  readonly maxAgeMs: number;
  readonly factCount: number;
  readonly localObservationDigest: string;
  readonly remoteObservationDigest: string;
  readonly localProvenanceDigest: string;
  readonly remoteProvenanceDigest: string;
  readonly localAcquisition: readonly RemoteShadowAcquisition[];
  readonly remoteAcquisition: readonly RemoteShadowAcquisition[];
  readonly localLatencyMs: number;
  readonly remoteLatencyMs: number;
  readonly issues: readonly RemoteShadowIssue[];
  readonly reportDigest: string;
};

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDeterministicJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isDeterministicJson);
  if (!isJsonObject(value)) return false;
  return Object.entries(value).every(([key, child]) => key.length > 0 && child !== undefined && isDeterministicJson(child));
}
