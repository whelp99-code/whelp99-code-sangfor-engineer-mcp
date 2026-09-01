import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  createLocalJmExecutionPort,
  createPlaywrightJmBrowserDriver,
  type LocalJmSession,
} from '../packages/sangfor-jm-execution/src/index.js';
import {
  closeOperatorSession,
  executeLiveConsoleAction,
  getOperatorSession,
  startOperatorSession,
} from '../packages/sangfor-operator/src/index.js';
import type { ApprovalActionRef } from '../packages/sangfor-operator/src/approval.js';
import {
  parseBrowserPortQaCommand,
  printBrowserPortQaHelp,
} from './lib/browser-port-qa-cli.js';
import { runRefusalScenario } from './lib/browser-port-qa-refusal.js';
import { approval, baseRequest } from './lib/browser-port-qa-requests.js';

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
  const command = parseBrowserPortQaCommand(process.argv.slice(2));
  switch (command.kind) {
    case 'help':
      printBrowserPortQaHelp();
      return;
    case 'refusal': {
      const output = await runRefusalScenario(command.scenario, command.baseUrl);
      console.log(JSON.stringify(output));
      if (output.status !== 'REFUSED') process.exitCode = 1;
      return;
    }
    case 'local-readback':
      await localReadBack(command.baseUrl);
      return;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'FAIL',
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
