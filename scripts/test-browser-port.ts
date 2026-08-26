import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { BrowserExecutionRequest } from '../packages/sangfor-browser-contracts/src/index.js';
import {
  createLocalJmExecutionPort,
  createPlaywrightJmBrowserDriver,
  type JmBrowserDriver,
  type LocalJmSession,
} from '../packages/sangfor-jm-execution/src/index.js';
import {
  closeOperatorSession,
  executeLiveConsoleAction,
  getOperatorSession,
  startOperatorSession,
} from '../packages/sangfor-operator/src/index.js';
import {
  signApprovalToken,
  type ApprovalActionRef,
  type SignedApproval,
} from '../packages/sangfor-operator/src/approval.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function baseRequest(
  session: LocalJmSession,
  operation: BrowserExecutionRequest['operation'],
): BrowserExecutionRequest {
  return {
    schemaVersion: 'browser-execution-request.v1',
    requestId: `qa-${operation.kind}-${randomUUID()}`,
    sessionId: session.sessionId,
    origin: session.origin,
    operation,
  };
}

function noOpDriver(): JmBrowserDriver {
  return {
    async execute() {
      throw new Error('Driver must not execute for this refusal scenario.');
    },
    async closeSession() {},
  };
}

function approval(
  secret: string,
  action: ApprovalActionRef,
): SignedApproval {
  const unsigned: Omit<SignedApproval, 'approvalToken'> = {
    approvedBy: 'ulw-browser-qa',
    changeTicketId: 'CHG-JM-BROWSER-QA',
    rollbackPlanId: 'RBK-JM-BROWSER-QA',
    nonce: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),

  authorityEpoch: 0,};
  return {
    ...unsigned,
    approvalToken: signApprovalToken(secret, action, unsigned),
  };
}

async function refusalScenario(scenario: string, baseUrl: string) {
  const parsedUrl = new URL(baseUrl);
  const session: LocalJmSession = {
    sessionId: 'qa-local-session',
    origin: parsedUrl.origin,
    targetUrl: parsedUrl.toString(),
    mode: 'lab',
  };
  const port = createLocalJmExecutionPort({
    resolveSession: () => session,
    driver: noOpDriver(),
  });
  const input = scenario === 'bad-origin'
    ? {
        ...baseRequest(session, { kind: 'observe_console' as const }),
        origin: 'https://other.example',
      }
    : {
        ...baseRequest(session, { kind: 'observe_console' as const }),
        operation: { kind: 'observe_console', selector: '#secret' },
      };
  const output = await port.execute(input as BrowserExecutionRequest);
  console.log(JSON.stringify(output));
  if (output.status !== 'REFUSED') process.exitCode = 1;
}

async function localReadBack(baseUrl: string) {
  const parsedUrl = new URL(baseUrl);
  const tempRoot = mkdtempSync(join(tmpdir(), 'jm-browser-qa-'));
  const evidenceDir = join(tempRoot, 'evidence');
  const noncePath = join(tempRoot, 'approval-nonces.json');
  const secret = 'ulw-local-browser-qa-secret';
  const previousEnv = {
    allow: process.env.SANGFOR_ALLOW_REAL_EXECUTION,
    secret: process.env.SANGFOR_OPERATOR_APPROVAL_SECRET,
    noncePath: process.env.SANGFOR_NONCE_STORE_PATH,
  };
  process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
  process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = secret;
  process.env.SANGFOR_NONCE_STORE_PATH = noncePath;
  const operatorSession = startOperatorSession({
    product: 'HCI',
    mode: 'lab',
    targetUrl: parsedUrl.toString(),
  });
  const driver = createPlaywrightJmBrowserDriver({ evidenceDir });
  const port = createLocalJmExecutionPort({
    resolveSession(sessionId) {
      const current = getOperatorSession(sessionId);
      if (current.id !== operatorSession.id || !current.targetUrl) return undefined;
      return {
        sessionId: current.id,
        origin: new URL(current.targetUrl).origin,
        targetUrl: current.targetUrl,
        mode: current.mode,
        headless: true,
      };
    },
    driver,
  });
  const session: LocalJmSession = {
    sessionId: operatorSession.id,
    origin: parsedUrl.origin,
    targetUrl: parsedUrl.toString(),
    mode: 'lab',
  };
  const initial = await fetch(new URL('/api/v1/mock-config', parsedUrl))
    .then((response) => response.json()) as { name: string };
  const changedName = `${initial.name}-jm-port-qa`;
  let restored = false;
  try {
    const observed = await port.execute(baseRequest(session, {
      kind: 'observe_console',
      includeSnapshot: true,
    }));
    const dryRun = await executeLiveConsoleAction({
      sessionId: session.sessionId,
      action: {
        type: 'type',
        target: 'config-name',
        value: `${initial.name}-dry-run-must-not-apply`,
        dryRun: true,
      },
      executionPort: port,
    });
    const dryRunReadBack = await port.execute(baseRequest(session, {
      kind: 'verify_console',
      checks: [{ id: 'config-name', kind: 'field_equals', expected: initial.name }],
    }));
    const typeAction: ApprovalActionRef = {
      type: 'type',
      target: 'config-name',
      value: changedName,
      dryRun: false,
    };
    const typed = await executeLiveConsoleAction({
      sessionId: session.sessionId,
      action: { type: 'type', target: 'config-name', value: changedName, dryRun: false },
      approval: approval(secret, typeAction),
      executionPort: port,
    });
    const clickAction: ApprovalActionRef = {
      type: 'click',
      target: 'Apply',
      dryRun: false,
    };
    const applied = await executeLiveConsoleAction({
      sessionId: session.sessionId,
      action: { type: 'click', target: 'Apply', dryRun: false },
      approval: approval(secret, clickAction),
      executionPort: port,
    });
    await port.execute(baseRequest(session, {
      kind: 'perform_console_action',
      action: { type: 'navigate', target: parsedUrl.toString(), dryRun: true },
    }));
    const changed = await port.execute(baseRequest(session, {
      kind: 'verify_console',
      checks: [{ id: 'config-name', kind: 'field_equals', expected: changedName }],
    }));
    const captured = await port.execute(baseRequest(session, {
      kind: 'capture_console_evidence',
      captureId: 'qa-capture',
      menuPath: [{ menu: 'Dashboard' }],
    }));
    const restoreType: ApprovalActionRef = {
      type: 'type',
      target: 'config-name',
      value: initial.name,
      dryRun: false,
    };
    await executeLiveConsoleAction({
      sessionId: session.sessionId,
      action: { type: 'type', target: 'config-name', value: initial.name, dryRun: false },
      approval: approval(secret, restoreType),
      executionPort: port,
    });
    const restoreClick: ApprovalActionRef = {
      type: 'click',
      target: 'Apply',
      dryRun: false,
    };
    await executeLiveConsoleAction({
      sessionId: session.sessionId,
      action: { type: 'click', target: 'Apply', dryRun: false },
      approval: approval(secret, restoreClick),
      executionPort: port,
    });
    await port.execute(baseRequest(session, {
      kind: 'perform_console_action',
      action: { type: 'navigate', target: parsedUrl.toString(), dryRun: true },
    }));
    const restoredResult = await port.execute(baseRequest(session, {
      kind: 'verify_console',
      checks: [{ id: 'config-name', kind: 'field_equals', expected: initial.name }],
    }));
    restored = restoredResult.status === 'PASS';
    const screenshot = captured.evidence[0]?.artifactRef;
    const finalScreenshot = resolve('.omo/evidence/jm-modular-monolith/c4-screenshot.png');
    if (screenshot) {
      mkdirSync(dirname(finalScreenshot), { recursive: true });
      await driver.materializeArtifact(screenshot, finalScreenshot);
    }
    const status = observed.status === 'PASS'
      && dryRun.ok
      && dryRunReadBack.status === 'PASS'
      && changed.status === 'PASS'
      && captured.status === 'PASS'
      && restored
      ? 'PASS'
      : 'FAIL';
    console.log(JSON.stringify({
      status,
      dryRunNonMutation: dryRunReadBack.status,
      mutationDispatch: { type: typed.ok, apply: applied.ok },
      readBack: changed.status,
      capture: {
        status: captured.status,
        error: captured.error,
        evidenceCount: captured.evidence.length,
      },
      restored: restoredResult.status,
      screenshot: screenshot ? finalScreenshot : null,
    }));
    if (status !== 'PASS') process.exitCode = 1;
  } finally {
    if (!restored) {
      await fetch(new URL('/api/v1/mock-config', parsedUrl), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: initial.name }),
      });
    }
    await closeOperatorSession(session.sessionId, port);
    rmSync(tempRoot, { recursive: true, force: true });
    if (previousEnv.allow === undefined) delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    else process.env.SANGFOR_ALLOW_REAL_EXECUTION = previousEnv.allow;
    if (previousEnv.secret === undefined) delete process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
    else process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = previousEnv.secret;
    if (previousEnv.noncePath === undefined) delete process.env.SANGFOR_NONCE_STORE_PATH;
    else process.env.SANGFOR_NONCE_STORE_PATH = previousEnv.noncePath;
  }
}

async function main() {
  const scenario = argument('--scenario');
  if (!scenario) throw new Error('Missing --scenario.');
  const baseUrl = argument('--base-url') ?? 'http://127.0.0.1:3400/hci';
  if (scenario === 'forbidden-operation' || scenario === 'bad-origin') {
    await refusalScenario(scenario, baseUrl);
    return;
  }
  if (scenario !== 'local-readback') throw new Error(`Unknown scenario: ${scenario}`);
  await localReadBack(baseUrl);
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'FAIL',
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
