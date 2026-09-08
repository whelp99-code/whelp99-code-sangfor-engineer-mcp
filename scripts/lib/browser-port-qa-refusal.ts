/**
 * The two browser-port refusal scenarios. Both run against a driver that
 * refuses to dispatch, so no browser is ever launched: the port must reject the
 * request before it reaches the driver.
 */
import type {
  BrowserExecutionRequest,
  BrowserExecutionResult,
} from '../../packages/sangfor-browser-contracts/src/index.js';
import {
  createLocalJmExecutionPort,
  type LocalJmSession,
} from '../../packages/sangfor-jm-execution/src/index.js';
import type { RefusalScenario } from './browser-port-qa-cli.js';
import { baseRequest, noOpDriver } from './browser-port-qa-requests.js';

/**
 * Held in a binding rather than inlined: as a fresh literal the excess
 * `selector` key would be a compile error instead of the runtime refusal the
 * scenario exists to prove.
 */
const FORBIDDEN_OPERATION = { kind: 'observe_console', selector: '#secret' } as const;

function refusalRequest(
  scenario: RefusalScenario,
  session: LocalJmSession,
): BrowserExecutionRequest {
  const request = baseRequest(session, { kind: 'observe_console' });
  switch (scenario) {
    case 'bad-origin':
      return { ...request, origin: 'https://other.example' };
    case 'forbidden-operation':
      return { ...request, operation: FORBIDDEN_OPERATION };
    default: {
      const exhaustive: never = scenario;
      return exhaustive;
    }
  }
}

export async function runRefusalScenario(
  scenario: RefusalScenario,
  baseUrl: string,
): Promise<BrowserExecutionResult> {
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
  return port.execute(refusalRequest(scenario, session));
}
