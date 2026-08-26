import { canonicalizeUrlOrigin, digestCanonicalOrigin } from '@sangfor/shared';
import { z } from 'zod';
import {
  structuralActionBindingsSchema,
  structuralApplicationIdSchema,
  structuralCanonicalHostSchema,
  structuralFirmwareTruthSchema,
  structuralImplementationDigestsSchema,
  structuralSessionIdSchema,
  structuralSha256Schema,
  structuralVerifierSessionIdSchema,
  structuralWindowIdSchema,
} from './iag-mutation-primitives.js';

export const IAG_ACTION_SCHEMA_VERSION = 'iag-internet-policy-action.v1' as const;

export const structuralIagMutationTargetSchema = z.object({
  product: z.literal('IAG'),
  capabilityId: z.literal('internet_policy'),
  environment: z.literal('lab'),
  deviceIdentityDigest: structuralSha256Schema,
  origin: z.string().min(1).max(2048),
  originDigest: structuralSha256Schema,
  sessionId: structuralSessionIdSchema,
  windowId: structuralWindowIdSchema,
}).strict().superRefine((target, context) => {
  let canonicalOrigin: string | undefined;
  try {
    canonicalOrigin = canonicalizeUrlOrigin(target.origin, 'origin');
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['origin'], message: 'Canonical HTTP(S) origin required.' });
  }
  if (canonicalOrigin !== undefined) {
    const hostname = new URL(canonicalOrigin).hostname;
    if (canonicalOrigin !== target.origin || hostname.includes('*') || hostname.endsWith('.')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['origin'], message: 'Unsafe or non-canonical origin refused.' });
    }
    if (digestCanonicalOrigin(canonicalOrigin, 'origin') !== target.originDigest) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['originDigest'], message: 'Origin digest mismatch.' });
    }
  }
}).readonly();

const urlAbsentStateSchema = z.object({
  kind: z.literal('URL_DOMAIN_EXCEPTION_ABSENT'), value: structuralCanonicalHostSchema,
}).strict();
const applicationAbsentStateSchema = z.object({
  kind: z.literal('APPLICATION_EXCEPTION_ABSENT'), applicationId: structuralApplicationIdSchema,
}).strict();
const urlPresentStateSchema = z.object({
  kind: z.literal('URL_DOMAIN_EXCEPTION_PRESENT'), value: structuralCanonicalHostSchema, effect: z.literal('ALLOW'),
}).strict();
const applicationPresentStateSchema = z.object({
  kind: z.literal('APPLICATION_EXCEPTION_PRESENT'), applicationId: structuralApplicationIdSchema, effect: z.literal('ALLOW'),
}).strict();
const unavailableStateSchema = z.object({
  kind: z.literal('UNAVAILABLE'), reasonCode: z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/u),
}).strict();

export const structuralIagAbsentStateSchema = z.discriminatedUnion('kind', [
  urlAbsentStateSchema, applicationAbsentStateSchema,
]).readonly();
export const structuralIagExpectedStateSchema = z.discriminatedUnion('kind', [
  urlPresentStateSchema, applicationPresentStateSchema,
]).readonly();
export const structuralIagObservedStateSchema = z.discriminatedUnion('kind', [
  urlAbsentStateSchema, applicationAbsentStateSchema, urlPresentStateSchema, applicationPresentStateSchema,
]).readonly();
export const structuralIagUnavailableStateSchema = unavailableStateSchema.readonly();

const preStateSchema = z.object({
  mode: z.literal('absent_or_exact_match'),
  observed: structuralIagObservedStateSchema,
}).strict().readonly();

const urlIntentSchema = z.object({
  kind: z.literal('URL_DOMAIN_EXCEPTION'), value: structuralCanonicalHostSchema, effect: z.literal('ALLOW'),
}).strict();
const applicationIntentSchema = z.object({
  kind: z.literal('APPLICATION_EXCEPTION'), applicationId: structuralApplicationIdSchema, effect: z.literal('ALLOW'),
}).strict();
export const structuralIagMutationIntentSchema = z.discriminatedUnion('kind', [
  urlIntentSchema, applicationIntentSchema,
]).readonly();

const readBackExpectationSchema = z.object({
  independent: z.literal(true),
  verifierSessionId: structuralVerifierSessionIdSchema,
  expected: structuralIagExpectedStateSchema,
}).strict().readonly();

export const structuralIagMutationActionSchema = z.object({
  schemaVersion: z.literal(IAG_ACTION_SCHEMA_VERSION),
  actionType: z.literal('IAG_INTERNET_POLICY_LAB_EXCEPTION'),
  bindings: structuralActionBindingsSchema,
  target: structuralIagMutationTargetSchema,
  firmwareTruth: structuralFirmwareTruthSchema,
  implementation: structuralImplementationDigestsSchema,
  dryRun: z.boolean().default(true),
  preState: preStateSchema,
  intent: structuralIagMutationIntentSchema,
  readBackExpectation: readBackExpectationSchema,
}).strict().superRefine((action, context) => {
  const roleIds = [
    ...Object.values(action.bindings), action.target.sessionId, action.target.windowId,
    action.firmwareTruth.recordId, action.readBackExpectation.verifierSessionId,
  ];
  if (new Set(roleIds).size !== roleIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['bindings'], message: 'Role IDs must be pairwise distinct.' });
  }
  switch (action.intent.kind) {
    case 'URL_DOMAIN_EXCEPTION': {
      const observed = action.preState.observed;
      const expected = action.readBackExpectation.expected;
      if ((observed.kind !== 'URL_DOMAIN_EXCEPTION_ABSENT' && observed.kind !== 'URL_DOMAIN_EXCEPTION_PRESENT')
        || observed.value !== action.intent.value || expected.kind !== 'URL_DOMAIN_EXCEPTION_PRESENT'
        || expected.value !== action.intent.value) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['intent'], message: 'URL state bindings disagree.' });
      }
      break;
    }
    case 'APPLICATION_EXCEPTION': {
      const observed = action.preState.observed;
      const expected = action.readBackExpectation.expected;
      if ((observed.kind !== 'APPLICATION_EXCEPTION_ABSENT' && observed.kind !== 'APPLICATION_EXCEPTION_PRESENT')
        || observed.applicationId !== action.intent.applicationId || expected.kind !== 'APPLICATION_EXCEPTION_PRESENT'
        || expected.applicationId !== action.intent.applicationId) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['intent'], message: 'Application state bindings disagree.' });
      }
      break;
    }
    default:
      action.intent satisfies never;
  }
}).readonly();

export type IagMutationIntent = z.infer<typeof structuralIagMutationIntentSchema>;
export type IagMutationExpectedState = z.infer<typeof structuralIagExpectedStateSchema>;
export type IagMutationObservedState = z.infer<typeof structuralIagObservedStateSchema>;
export type GroundedIagMutationAction = z.infer<typeof structuralIagMutationActionSchema>;
