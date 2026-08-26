import { writeFileSync } from 'node:fs';
import {
  digestIagMutationAction,
  parseIagMutationAction,
} from '../../packages/sangfor-product-adapters/src/apply/index.js';
import { resolveIagMutationActionAuthority } from '../../packages/sangfor-competency/src/index.js';
import {
  signIagMutationApproval,
  type IagMutationApproval,
} from '../../packages/sangfor-operator/src/index.js';
import {
  IAG_ORDINARY_APPROVAL_SECRET,
  iagOrchestratorFixture,
} from './iag-orchestrator-fixture.js';

type Fixture = Awaited<ReturnType<typeof iagOrchestratorFixture>>;

export function mintTerminalReplayApproval(
  fixture: Fixture,
  nonce: string,
  actionDigest = fixture.actionDigest,
): IagMutationApproval {
  const fields = {
    approvedBy: 'operator-replay', changeTicketId: 'CHG-REPLAY', rollbackPlanId: 'RB-REPLAY',
    purpose: 'ordinary_change' as const, nonce, expiresAt: '2026-08-20T12:00:00.000Z',

  authorityEpoch: 0,};
  const action = fixture.action;
  const scope = {
    actionDigest, origin: action.target.origin,
    deviceIdentityDigest: action.target.deviceIdentityDigest,
    sessionId: action.target.sessionId, windowId: action.target.windowId,
  };
  return {
    ...fields,
    approvalToken: signIagMutationApproval(IAG_ORDINARY_APPROVAL_SECRET, scope, fields),
  };
}

export function changedTerminalReplaySource(fixture: Fixture): string {
  const parsed: unknown = JSON.parse(fixture.source);
  if (typeof parsed !== 'object' || parsed === null) throw new TypeError('IAG_ACTION_FIXTURE_INVALID');
  const preState = Reflect.get(parsed, 'preState');
  if (typeof preState !== 'object' || preState === null) throw new TypeError('IAG_PRESTATE_FIXTURE_INVALID');
  Reflect.set(preState, 'observed', {
    kind: 'URL_DOMAIN_EXCEPTION_PRESENT', value: 'qa.example.invalid', effect: 'ALLOW',
  });
  return JSON.stringify(parsed);
}

export async function mintChangedTerminalReplayApproval(
  fixture: Fixture,
  source: string,
  nonce: string,
): Promise<IagMutationApproval> {
  const authority = await resolveIagMutationActionAuthority(fixture.authorityRequest);
  if (!authority.ok) throw new TypeError(authority.code);
  const action = parseIagMutationAction({ source, authority: authority.authority });
  if (!action.ok) throw new TypeError(action.refusal.code);
  return mintTerminalReplayApproval(fixture, nonce, digestIagMutationAction(action.value));
}

export function writeApprovalEnvelope(path: string, approval: unknown): void {
  writeFileSync(path, JSON.stringify(approval));
}
