import {
  resolveIagMutationActionAuthority,
  type IagMutationActionAuthority,
} from '../../packages/sangfor-competency/src/index.js';
import {
  digestIagMutationAction,
  digestIagReadBackProof,
  digestIagObservedState,
  parseIagMutationAction,
  parseIagReadBackProof,
  type GroundedIagMutationAction,
  type GroundedIagReadBackProof,
} from '../../packages/sangfor-product-adapters/src/apply/index.js';
import { digestCanonicalOrigin } from '../../packages/shared/src/index.js';
import {
  configureAuthorityEnvironment,
  writeAuthorityFixture,
} from './write-authorization-authority-fixture.js';

export const ORIGIN = 'https://iag.lab.example.invalid';
export const URL_VALUE = 'qa.example.invalid';
export const APP_ID = 'app.vendor-suite_42';
const digest = (value: string): string => value.repeat(64);

export async function resolveTestIagMutationAuthority(root: string): Promise<IagMutationActionAuthority> {
  const fixture = await writeAuthorityFixture({
    root, product: 'IAG', capabilityId: 'internet_policy',
    toolId: 'iag_o1_evidence_campaign', fieldVerified: false, mockCampaign: true,
  });
  configureAuthorityEnvironment(root);
  const resolved = await resolveIagMutationActionAuthority({
    references: fixture.refs,
    origin: fixture.scope.originId,
    allowedUrlDomains: [
      URL_VALUE, 'example.com', 'www.example.com',
      'com', 'co.uk', 'github.io', '127.0.0.1', '*.example.invalid', 'example.invalid.', 'example.invalid/path',
    ],
    allowedApplicationIds: [APP_ID],
    now: new Date('2026-08-20T11:00:00.000Z'),
    firmwareFreshness: { maxAgeMs: 7_200_000, maxFutureSkewMs: 30_000 },
  });
  if (!resolved.ok) throw new TypeError(`Genuine authority fixture refused: ${resolved.code}`);
  return resolved.authority;
}

export function cleanupTestIagMutationAuthorityEnvironment(): void {
  for (const key of [
    'SANGFOR_COMPETENCY_ROOT',
    'SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET',
    'SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET',
  ]) delete process.env[key];
}

export function urlActionInput(
  observed: 'ABSENT' | 'EXACT_MATCH' = 'ABSENT',
  authority?: IagMutationActionAuthority,
) {
  const value = URL_VALUE;
  const desired = { kind: 'URL_DOMAIN_EXCEPTION_PRESENT', value, effect: 'ALLOW' } as const;
  const origin = authority?.origin ?? ORIGIN;
  return {
    schemaVersion: 'iag-internet-policy-action.v1',
    actionType: 'IAG_INTERNET_POLICY_LAB_EXCEPTION',
    bindings: {
      planId: 'plan-o1-13', taskId: 'task-o1-13',
      campaignId: authority?.campaignId ?? 'campaign-o1-13', idempotencyKey: 'idem-o1-13',
    },
    target: {
      product: 'IAG', capabilityId: 'internet_policy', environment: 'lab',
      deviceIdentityDigest: authority?.deviceIdentityDigest ?? digest('1'),
      origin, originDigest: authority?.originDigest ?? digestCanonicalOrigin(origin, 'origin'),
      sessionId: authority?.sessionId ?? 'session-o1-13',
      windowId: authority?.windowId ?? 'window-o1-13',
    },
    firmwareTruth: authority?.firmwareTruth ?? {
      recordId: 'firmware-o1-13', vendor: 'SANGFOR', adapterProduct: 'IAG', productVariant: 'IAG',
      versionRaw: '13.0.120', versionFamily: '13.0', revision: null, buildId: '120', hotfix: null,
      uiFingerprint: digest('8'), apiFingerprint: null, status: 'verified',
      observedAt: '2026-08-26T00:00:00.000Z', specVersion: '13.0.120',
      specApplicability: 'verified', truthDigest: digest('2'),
    },
    implementation: authority?.implementation
      ?? { recipeDigest: digest('3'), toolDigest: digest('4'), runtimeDigest: digest('5') },
    dryRun: false,
    preState: {
      mode: 'absent_or_exact_match',
      observed: observed === 'ABSENT'
        ? { kind: 'URL_DOMAIN_EXCEPTION_ABSENT', value }
        : desired,
    },
    intent: { kind: 'URL_DOMAIN_EXCEPTION', value, effect: 'ALLOW' },
    readBackExpectation: {
      independent: true, verifierSessionId: 'verifier-session-o1-13', expected: desired,
    },
  } as const;
}

export function applicationActionInput(authority?: IagMutationActionAuthority) {
  const applicationId = APP_ID;
  return {
    ...urlActionInput('ABSENT', authority),
    preState: {
      mode: 'absent_or_exact_match',
      observed: { kind: 'APPLICATION_EXCEPTION_ABSENT', applicationId },
    },
    intent: { kind: 'APPLICATION_EXCEPTION', applicationId, effect: 'ALLOW' },
    readBackExpectation: {
      independent: true,
      verifierSessionId: 'verifier-session-o1-13',
      expected: { kind: 'APPLICATION_EXCEPTION_PRESENT', applicationId, effect: 'ALLOW' },
    },
  } as const;
}

export function groundAction(input: unknown, authority: IagMutationActionAuthority): GroundedIagMutationAction {
  const parsed = parseIagMutationAction({ source: JSON.stringify(input), authority });
  if (!parsed.ok) throw new TypeError(`Fixture action refused: ${parsed.refusal.code}`);
  return parsed.value;
}

export function matchedProofInput(action: GroundedIagMutationAction) {
  const observed = action.readBackExpectation.expected;
  return {
    schemaVersion: 'iag-independent-readback.v1', action,
    actionDigest: digestIagMutationAction(action),
    verifierSessionId: action.readBackExpectation.verifierSessionId,
    result: 'MATCHED', expected: action.readBackExpectation.expected, observed,
    observedStateDigest: digestIagObservedState(observed),
    observedAt: '2026-08-26T01:01:00.000Z',
  } as const;
}

export function mismatchProofInput(action: GroundedIagMutationAction) {
  const observed = action.intent.kind === 'URL_DOMAIN_EXCEPTION'
    ? { kind: 'URL_DOMAIN_EXCEPTION_ABSENT', value: action.intent.value } as const
    : { kind: 'APPLICATION_EXCEPTION_ABSENT', applicationId: action.intent.applicationId } as const;
  return { ...matchedProofInput(action), result: 'MISMATCHED', observed, observedStateDigest: digestIagObservedState(observed) } as const;
}

export function indeterminateProofInput(action: GroundedIagMutationAction) {
  return {
    ...matchedProofInput(action), result: 'INDETERMINATE',
    observed: { kind: 'UNAVAILABLE', reasonCode: 'READ_BACK_UNAVAILABLE' }, observedStateDigest: null,
  } as const;
}

export function groundProof(input: unknown, action: GroundedIagMutationAction): GroundedIagReadBackProof {
  const parsed = parseIagReadBackProof({ source: JSON.stringify(input), action });
  if (!parsed.ok) throw new TypeError(`Fixture proof refused: ${parsed.refusal.code}`);
  return parsed.value;
}

export function successResultInput(action: GroundedIagMutationAction, proof: GroundedIagReadBackProof) {
  return {
    schemaVersion: 'iag-internet-policy-result.v1', outcome: 'SUCCEEDED', action,
    actionDigest: digestIagMutationAction(action), readBackProofDigest: digestIagReadBackProof(proof),
    promotionEligible: false, mutation: { attempted: true, count: 1 }, verifiedSuccess: true,
    finalReadBack: 'MATCHED',
  } as const;
}
