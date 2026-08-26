import {
  isIagMutationActionAuthority,
  type IagMutationActionAuthority,
} from '@sangfor/competency';
import {
  structuralIagMutationActionSchema,
  type GroundedIagMutationAction,
} from './iag-mutation-action.js';
import { isGroundedAction, registerGroundedAction } from './iag-mutation-authority.js';
import {
  canonicalIagValuesEqual,
  digestCanonicalIagValue,
} from './iag-mutation-canonical.js';
import {
  parseStructuralJson,
  refused,
  type IagMutationParseResult,
} from './iag-mutation-parser.js';

const ACTION_DIGEST_DOMAIN = 'sangfor.iag.mutation-action.v1';

function exactAuthorityScope(action: GroundedIagMutationAction, authority: IagMutationActionAuthority): boolean {
  return action.target.product === authority.product
    && action.target.capabilityId === authority.capabilityId
    && authority.toolId === 'iag_o1_evidence_campaign'
    && action.target.deviceIdentityDigest === authority.deviceIdentityDigest
    && action.target.origin === authority.origin
    && action.target.originDigest === authority.originDigest
    && action.bindings.campaignId === authority.campaignId
    && action.target.sessionId === authority.sessionId
    && action.target.windowId === authority.windowId
    && canonicalIagValuesEqual(action.firmwareTruth, authority.firmwareTruth)
    && canonicalIagValuesEqual(action.implementation, authority.implementation);
}

export function parseIagMutationAction(input: {
  readonly source: string;
  readonly authority: unknown;
}): IagMutationParseResult<GroundedIagMutationAction> {
  if (!isIagMutationActionAuthority(input.authority)) return refused('action_authority_refused');
  const authority = input.authority;
  const parsed = parseStructuralJson({
    source: input.source,
    schema: structuralIagMutationActionSchema,
    schemaName: 'iag-internet-policy-action.v1',
  });
  if (!parsed.ok) return parsed;

  const action = parsed.value;
  let authorized = exactAuthorityScope(action, authority);
  switch (action.intent.kind) {
    case 'URL_DOMAIN_EXCEPTION':
      authorized = authority.allowedIntents.urlDomains.includes(action.intent.value) && authorized;
      break;
    case 'APPLICATION_EXCEPTION':
      authorized = authority.allowedIntents.applicationIds.includes(action.intent.applicationId) && authorized;
      break;
    default:
      action.intent satisfies never;
  }

  const age = Date.parse(authority.now) - Date.parse(action.firmwareTruth.observedAt);
  if (age > authority.firmwareFreshness.maxAgeMs
    || age < -authority.firmwareFreshness.maxFutureSkewMs) authorized = false;
  if (!authorized) return refused('action_authority_refused');
  return { ok: true, value: registerGroundedAction(action) };
}

export function isGroundedIagMutationAction(action: unknown): action is GroundedIagMutationAction {
  return isGroundedAction(action);
}

export function digestIagMutationAction(action: unknown): string {
  if (!isGroundedIagMutationAction(action)) throw new TypeError('IAG_ACTION_AUTHORITY_REQUIRED');
  return digestCanonicalIagValue(ACTION_DIGEST_DOMAIN, action);
}
