import type { BrowserExecutionResult } from '@sangfor/browser-contracts';
import { z } from 'zod';
import { canonicalIagValuesEqual } from './iag-mutation-canonical.js';
import {
  structuralIagExpectedStateSchema,
  type GroundedIagMutationAction,
  type IagMutationObservedState,
} from './iag-mutation-action.js';
import {
  structuralImplementationDigestsSchema,
  structuralSha256Schema,
  structuralTaskIdSchema,
} from './iag-mutation-primitives.js';

export const IAG_POLICY_OBSERVATION_SCHEMA_VERSION = 'iag-policy-observation.v1' as const;

const policyBaseSchema = z.object({
  product: z.literal('IAG'),
  capabilityId: z.literal('internet_policy'),
  taskId: structuralTaskIdSchema,
});
const readyPolicySchema = policyBaseSchema.extend({
  status: z.literal('READY'),
  entries: z.array(structuralIagExpectedStateSchema),
}).strict();
const missingPolicySchema = policyBaseSchema.extend({
  status: z.literal('MISSING'),
  entries: z.array(structuralIagExpectedStateSchema).max(0),
}).strict();
const unreadyPolicySchema = policyBaseSchema.extend({
  status: z.literal('UNREADY'),
  entries: z.array(structuralIagExpectedStateSchema).max(0),
  reasonCode: z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/u),
}).strict();

export const iagPolicyObservationSchema = z.object({
  schemaVersion: z.literal(IAG_POLICY_OBSERVATION_SCHEMA_VERSION),
  origin: z.string().url(),
  originDigest: structuralSha256Schema,
  deviceIdentityDigest: structuralSha256Schema,
  firmwareTruthDigest: structuralSha256Schema,
  implementation: structuralImplementationDigestsSchema,
  policy: z.discriminatedUnion('status', [readyPolicySchema, missingPolicySchema, unreadyPolicySchema]),
}).strict().readonly();

export type IagPolicyObservation = z.infer<typeof iagPolicyObservationSchema>;
export type IagObservationResolution =
  | { readonly status: 'ABSENT' | 'EXACT'; readonly observation: IagPolicyObservation; readonly observed: IagMutationObservedState }
  | { readonly status: 'AMBIGUOUS' | 'MISSING' | 'UNREADY' | 'REFUSED'; readonly reasonCode: string; readonly observation?: IagPolicyObservation };

function absentState(action: GroundedIagMutationAction): IagMutationObservedState {
  switch (action.intent.kind) {
    case 'URL_DOMAIN_EXCEPTION':
      return { kind: 'URL_DOMAIN_EXCEPTION_ABSENT', value: action.intent.value };
    case 'APPLICATION_EXCEPTION':
      return { kind: 'APPLICATION_EXCEPTION_ABSENT', applicationId: action.intent.applicationId };
    default:
      action.intent satisfies never;
      throw new TypeError('IAG_INTENT_EXHAUSTIVENESS');
  }
}

function targetsAction(entry: IagPolicyObservation['policy']['entries'][number], action: GroundedIagMutationAction): boolean {
  switch (action.intent.kind) {
    case 'URL_DOMAIN_EXCEPTION':
      return entry.kind === 'URL_DOMAIN_EXCEPTION_PRESENT' && entry.value === action.intent.value;
    case 'APPLICATION_EXCEPTION':
      return entry.kind === 'APPLICATION_EXCEPTION_PRESENT' && entry.applicationId === action.intent.applicationId;
    default:
      action.intent satisfies never;
      return false;
  }
}

function scopeMatches(observation: IagPolicyObservation, action: GroundedIagMutationAction): boolean {
  return observation.origin === action.target.origin
    && observation.originDigest === action.target.originDigest
    && observation.deviceIdentityDigest === action.target.deviceIdentityDigest
    && observation.firmwareTruthDigest === action.firmwareTruth.truthDigest
    && observation.policy.product === action.target.product
    && observation.policy.capabilityId === action.target.capabilityId
    && observation.policy.taskId === action.bindings.taskId
    && canonicalIagValuesEqual(observation.implementation, action.implementation);
}

export function resolveIagPolicyObservation(input: {
  readonly action: GroundedIagMutationAction;
  readonly result: BrowserExecutionResult;
  readonly requestId: string;
}): IagObservationResolution {
  if (input.result.requestId !== input.requestId
    || input.result.status !== 'PASS'
    || input.result.readBack?.status !== 'PASS'
    || input.result.mutationAttempted) {
    return { status: 'UNREADY', reasonCode: 'OBSERVATION_NOT_AUTHORITATIVE' };
  }
  const parsed = iagPolicyObservationSchema.safeParse(input.result.observations?.iagPolicy);
  if (!parsed.success) return { status: 'UNREADY', reasonCode: 'OBSERVATION_MALFORMED' };
  const observation = parsed.data;
  if (!scopeMatches(observation, input.action)) {
    return { status: 'REFUSED', reasonCode: 'TARGET_SCOPE_DRIFT', observation };
  }
  switch (observation.policy.status) {
    case 'MISSING':
      return { status: 'MISSING', reasonCode: 'POLICY_MISSING', observation };
    case 'UNREADY':
      return { status: 'UNREADY', reasonCode: observation.policy.reasonCode, observation };
    case 'READY': {
      const matches = observation.policy.entries.filter((entry) => targetsAction(entry, input.action));
      if (matches.length > 1) return { status: 'AMBIGUOUS', reasonCode: 'MULTIPLE_EXACT_TARGETS', observation };
      const exact = matches[0];
      if (exact !== undefined) return { status: 'EXACT', observation, observed: exact };
      return { status: 'ABSENT', observation, observed: absentState(input.action) };
    }
    default:
      observation.policy satisfies never;
      return { status: 'UNREADY', reasonCode: 'POLICY_STATE_UNKNOWN' };
  }
}
