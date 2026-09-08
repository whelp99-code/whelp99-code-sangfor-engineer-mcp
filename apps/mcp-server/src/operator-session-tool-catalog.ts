import { startOperatorSession, readConsoleState, executeConsoleAction, readLiveConsoleState, executeLiveConsoleAction, closeOperatorSession } from '../../../packages/sangfor-operator/src/index.js';
import { requiredBrowserExecutionPort } from './browser-runtime-composition.js';
import { verifyResult } from '../../../packages/sangfor-verifier/src/index.js';
import { plans } from './domain-session-state.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const operatorSessionToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_start_operator_session", {
    description: 'Start a mock/lab/poc/customer operator session. MVP defaults to mock.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, mode: { type: 'string' }, targetUrl: { type: 'string' }, browser: { type: 'object', properties: { cdpEndpoint: { type: 'string' }, useLocalBrowser: { type: 'boolean' } } } }, required: ['product'] },
    handler: startOperatorSession
  }],
  ["sangfor_read_console_state", {
    description: 'Read current mock console state for a session.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    handler: ({ sessionId }) => readConsoleState(sessionId)
  }],
  ["sangfor_execute_console_action", {
    description: 'Execute or dry-run a console action. MVP blocks high-risk non-dry-run operations.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, action: { type: 'object' } }, required: ['sessionId', 'action'] },
    handler: ({ sessionId, action }) => executeConsoleAction(sessionId, action)
  }],
  ["sangfor_read_live_console_state", {
    description: 'Read live Sangfor Web Console state using Playwright. Requires targetUrl session. Read-only snapshot.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    handler: (args: Omit<Parameters<typeof readLiveConsoleState>[0], 'executionPort'>) => readLiveConsoleState({ ...args, executionPort: requiredBrowserExecutionPort() })
  }],
  ["sangfor_execute_console_action_live", {
    description: 'Execute a real Playwright console action. Requires SANGFOR_ALLOW_REAL_EXECUTION and approval fields for non-dry-run.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, action: { type: 'object' }, approval: { type: 'object' } }, required: ['sessionId', 'action'] },
    handler: (args: Omit<Parameters<typeof executeLiveConsoleAction>[0], 'executionPort'>) => executeLiveConsoleAction({ ...args, executionPort: requiredBrowserExecutionPort() })
  }],
  ["sangfor_kill_session", {
    description: 'Cancel an operator session.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    handler: ({ sessionId }) => closeOperatorSession(
      sessionId,
      requiredBrowserExecutionPort(),
    ),
  }],
  ["sangfor_verify_result", {
    description: 'Verify plan/result. MVP returns manual validation checklist.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, plan: { type: 'object' }, observed: { type: 'object' } } },
    handler: ({ planId, plan, observed }) => verifyResult({ plan: plan ?? plans.get(planId), observed })
  }],
];
