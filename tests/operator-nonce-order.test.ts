import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserExecutionPort,
  BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import { signApprovalToken } from '../packages/sangfor-operator/src/approval.js';
import {
  consumeApprovalNonce,
  executeLiveConsoleAction,
  getOperatorSession,
  killSession,
  startOperatorSession,
  type LiveExecutionApproval,
} from '../packages/sangfor-operator/src/index.js';
import type { ConsoleAction } from '../packages/shared/src/index.js';

const SECRET = 'nonce-order-secret';
const roots: string[] = [];
const sessions: string[] = [];

function approval(action: ConsoleAction, nonce: string): LiveExecutionApproval {
  const fields = {
    approvedBy: 'cm@corp',
    changeTicketId: 'CHG-NONCE',
    rollbackPlanId: 'RBK-NONCE',
    nonce,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),

  authorityEpoch: 0,};
  return {
    ...fields,
    approvalToken: signApprovalToken(SECRET, action, fields),
  };
}

function passingPort(): BrowserExecutionPort {
  return {
    execute: vi.fn(async (request): Promise<BrowserExecutionResult> => ({
      schemaVersion: 'browser-execution-result.v1',
      requestId: request.requestId,
      status: 'PASS',
      mutationAttempted: request.operation.kind === 'perform_console_action',
      readBack: { status: 'PASS' },
      evidence: [],
    })),
  };
}

beforeEach(() => {
  process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
  process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = SECRET;
  const root = mkdtempSync(join(tmpdir(), 'operator-nonce-order-'));
  roots.push(root);
  process.env.SANGFOR_NONCE_STORE_PATH = join(root, 'nonces.json');
});

afterEach(() => {
  delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
  delete process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
  delete process.env.SANGFOR_NONCE_STORE_PATH;
  for (const sessionId of sessions.splice(0)) killSession(sessionId);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('operator nonce ordering', () => {
  it('keeps dispatched mutations in verification-required state', async () => {
    const session = startOperatorSession({
      product: 'HCI',
      mode: 'lab',
      targetUrl: 'http://127.0.0.1:3400/hci',
    });
    sessions.push(session.id);
    const action = {
      type: 'click',
      target: 'Apply',
      dryRun: false,
    } satisfies ConsoleAction;
    const port = passingPort();
    vi.mocked(port.execute)
      .mockResolvedValueOnce({
        schemaVersion: 'browser-execution-result.v1',
        requestId: 'preflight',
        status: 'PASS',
        mutationAttempted: false,
        readBack: { status: 'PASS' },
        evidence: [],
      })
      .mockResolvedValueOnce({
        schemaVersion: 'browser-execution-result.v1',
        requestId: 'mutation',
        status: 'INDETERMINATE',
        mutationAttempted: true,
        readBack: { status: 'INDETERMINATE' },
        evidence: [],
      });

    const output = await executeLiveConsoleAction({
      sessionId: session.id,
      action,
      approval: approval(action, 'nonce-verification-required'),
      executionPort: port,
    });

    expect(output.ok).toBe(false);
    expect(getOperatorSession(session.id).status).toBe('verification_required');
  });

  it('does not consume approval before the execution port is available', async () => {
    const session = startOperatorSession({
      product: 'HCI',
      mode: 'lab',
      targetUrl: 'http://127.0.0.1:3400/hci',
    });
    sessions.push(session.id);
    const action = {
      type: 'click',
      target: 'Apply',
      dryRun: false,
    } satisfies ConsoleAction;
    const signed = approval(action, 'nonce-port-unavailable');

    await expect(executeLiveConsoleAction({
      sessionId: session.id,
      action,
      approval: signed,
    })).rejects.toThrow(/BROWSER_EXECUTION_PORT_REQUIRED/);

    await expect(executeLiveConsoleAction({
      sessionId: session.id,
      action,
      approval: signed,
      executionPort: passingPort(),
    })).resolves.toMatchObject({ ok: true });
  });

  it('does not consume approval for a cross-origin navigation refusal', async () => {
    const session = startOperatorSession({
      product: 'HCI',
      mode: 'lab',
      targetUrl: 'http://127.0.0.1:3400/hci',
    });
    sessions.push(session.id);
    const action = {
      type: 'navigate',
      target: 'https://attacker.example/admin',
      dryRun: false,
    } satisfies ConsoleAction;
    const signed = approval(action, 'nonce-cross-origin');

    await expect(executeLiveConsoleAction({
      sessionId: session.id,
      action,
      approval: signed,
      executionPort: passingPort(),
    })).rejects.toThrow(/outside the session origin/);

    expect(await consumeApprovalNonce({
      nonce: signed.nonce,
      expiresAt: signed.expiresAt,

    authorityEpoch: 0,})).toMatchObject({ ok: true });
  });
});
