import { describe, expect, it } from 'vitest';
import type { BrowserExecutionRequest, BrowserExecutionResult } from '../packages/sangfor-browser-contracts/src/index.js';
import {
  createLocalJmExecutionPort,
  type JmBrowserDriver,
  type LocalJmSession,
} from '../packages/sangfor-jm-execution/src/index.js';
import {
  verifyExecutionApproval,
  type ApprovalActionRef,
} from '../packages/sangfor-operator/src/approval.js';
import {
  BrowserPortQaArgumentError,
  parseBrowserPortQaCommand,
} from '../scripts/lib/browser-port-qa-cli.js';
import { runRefusalScenario } from '../scripts/lib/browser-port-qa-refusal.js';
import { approval, baseRequest, noOpDriver } from '../scripts/lib/browser-port-qa-requests.js';

const BASE_URL = 'http://127.0.0.1:3400/hci';

const session: LocalJmSession = {
  sessionId: 'qa-local-session',
  origin: 'http://127.0.0.1:3400',
  targetUrl: BASE_URL,
  mode: 'lab',
};

/**
 * In-memory stand-in for the Playwright driver: it records the dispatched
 * request and answers with an authoritative PASS, so the happy path is provable
 * without launching a browser.
 */
function fakeHappyDriver(): JmBrowserDriver & { readonly dispatched: BrowserExecutionRequest[] } {
  const dispatched: BrowserExecutionRequest[] = [];
  return {
    dispatched,
    async execute(_session, request): Promise<BrowserExecutionResult> {
      dispatched.push(request);
      return {
        schemaVersion: 'browser-execution-result.v1',
        requestId: request.requestId,
        status: 'PASS',
        mutationAttempted: false,
        readBack: { status: 'PASS' },
        evidence: [],
      };
    },
    async closeSession() {},
  };
}

describe('browser-port QA argument parsing', () => {
  it('Given only the scenario flag, When parsed, Then the documented default base URL is applied', () => {
    const command = parseBrowserPortQaCommand(['--scenario', 'local-readback']);

    expect(command).toEqual({ kind: 'local-readback', baseUrl: BASE_URL });
  });

  it('Given an explicit base URL that differs from the default, When parsed, Then the explicit value wins', () => {
    const command = parseBrowserPortQaCommand(['--scenario', 'bad-origin', '--base-url', 'http://127.0.0.1:3999/iag']);

    expect(command).toEqual({ kind: 'refusal', scenario: 'bad-origin', baseUrl: 'http://127.0.0.1:3999/iag' });
  });

  it('Given a help flag alongside a scenario, When parsed, Then help wins and nothing is executed', () => {
    const command = parseBrowserPortQaCommand(['--scenario', 'local-readback', '--help']);

    expect(command).toEqual({ kind: 'help' });
  });

  it.each([
    ['a missing scenario', [], 'Missing --scenario.'],
    ['a valueless scenario flag', ['--scenario'], 'Missing --scenario.'],
    ['an unknown scenario', ['--scenario', 'local-read-back'], 'Unknown scenario: local-read-back'],
  ] as const)('Given %s, When parsed, Then a typed argument error names the refusal', (_case, args, message) => {
    expect(() => parseBrowserPortQaCommand(args)).toThrow(BrowserPortQaArgumentError);
    expect(() => parseBrowserPortQaCommand(args)).toThrow(message);
  });
});

describe('browser-port QA request fixtures', () => {
  it('Given a session and an operation, When a request is built, Then it is bound to that session with a scenario-tagged unique id', () => {
    const first = baseRequest(session, { kind: 'observe_console', includeSnapshot: true });
    const second = baseRequest(session, { kind: 'observe_console', includeSnapshot: true });

    expect(first).toMatchObject({
      schemaVersion: 'browser-execution-request.v1',
      sessionId: session.sessionId,
      origin: session.origin,
      operation: { kind: 'observe_console', includeSnapshot: true },
    });
    expect(first.requestId.startsWith('qa-observe_console-')).toBe(true);
    expect(second.requestId).not.toBe(first.requestId);
  });

  it('Given a signed approval, When verified against the action it was minted for, Then it is accepted before expiry', () => {
    const action: ApprovalActionRef = { type: 'type', target: 'config-name', value: 'renamed', dryRun: false };
    const signed = approval('qa-secret', action);

    const verdict = verifyExecutionApproval({
      action,
      approval: signed,
      secret: 'qa-secret',
      now: new Date(Date.parse(signed.expiresAt) - 1_000),
    });

    expect(verdict).toEqual({ ok: true });
  });

  it.each([
    ['a different action', { type: 'type', target: 'config-name', value: 'other-value', dryRun: false }, 'qa-secret'],
    ['a different secret', { type: 'type', target: 'config-name', value: 'renamed', dryRun: false }, 'other-secret'],
  ] as const)('Given %s, When the approval is verified, Then it is refused as a signature mismatch', (_case, action, secret) => {
    const minted: ApprovalActionRef = { type: 'type', target: 'config-name', value: 'renamed', dryRun: false };
    const signed = approval('qa-secret', minted);

    const verdict = verifyExecutionApproval({
      action,
      approval: signed,
      secret,
      now: new Date(Date.parse(signed.expiresAt) - 1_000),
    });

    expect(verdict).toEqual({ ok: false, reason: 'approval token signature mismatch' });
  });

  it('Given a signed approval, When verified after its expiry, Then it is refused as expired', () => {
    const action: ApprovalActionRef = { type: 'click', target: 'Apply', dryRun: false };
    const signed = approval('qa-secret', action);

    const verdict = verifyExecutionApproval({
      action,
      approval: signed,
      secret: 'qa-secret',
      now: new Date(Date.parse(signed.expiresAt) + 1_000),
    });

    expect(verdict).toEqual({ ok: false, reason: 'approval expired' });
  });

  it('Given the refusal-scenario driver, When it is asked to execute, Then it refuses instead of reaching a browser', async () => {
    await expect(noOpDriver().execute(session, baseRequest(session, { kind: 'observe_console' })))
      .rejects.toThrow('Driver must not execute for this refusal scenario.');
  });
});

describe('browser-port QA scenarios without a browser', () => {
  it('Given the bad-origin scenario, When it runs, Then the port refuses the mismatched origin', async () => {
    const output = await runRefusalScenario('bad-origin', BASE_URL);

    expect(output).toMatchObject({
      status: 'REFUSED',
      mutationAttempted: false,
      error: { code: 'SESSION_ORIGIN_MISMATCH' },
    });
  });

  it('Given the forbidden-operation scenario, When it runs, Then the strict request schema refuses the extra operation key', async () => {
    const output = await runRefusalScenario('forbidden-operation', BASE_URL);

    expect(output).toMatchObject({
      status: 'REFUSED',
      mutationAttempted: false,
      error: { code: 'INVALID_BROWSER_REQUEST' },
    });
    expect(output.error?.message).toContain('selector');
  });

  it('Given an unusable base URL, When a scenario runs, Then the URL failure propagates to the caller', async () => {
    await expect(runRefusalScenario('bad-origin', 'not-a-url')).rejects.toThrow(TypeError);
  });

  it('Given a fake driver that answers with an authoritative PASS, When a QA request is dispatched, Then the port passes it through unchanged', async () => {
    const driver = fakeHappyDriver();
    const port = createLocalJmExecutionPort({
      resolveSession: (sessionId) => sessionId === session.sessionId ? session : undefined,
      driver,
    });
    const request = baseRequest(session, { kind: 'observe_console', includeSnapshot: true });

    const output = await port.execute(request);

    expect(output).toMatchObject({ status: 'PASS', requestId: request.requestId, readBack: { status: 'PASS' } });
    expect(driver.dispatched).toEqual([request]);
  });
});
