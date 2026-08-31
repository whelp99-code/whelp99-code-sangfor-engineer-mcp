import type {
  BrowserExecutionContext,
  BrowserExecutionPort,
  BrowserExecutionRequest,
  BrowserExecutionResult,
} from './browser-execution.js';

const executionAuthorityBrand = Symbol('BrowserExecutionAuthorityPort');
const authorityRoots = new WeakMap<BrowserExecutionPort, object>();

export interface BrowserExecutionAuthorityPort extends BrowserExecutionPort {
  readonly [executionAuthorityBrand]: true;
}

export function createBrowserExecutionAuthorityPort(
  delegate: BrowserExecutionPort,
): BrowserExecutionAuthorityPort {
  const root = authorityRoots.get(delegate) ?? delegate;
  authorityRoots.set(delegate, root);
  const port: BrowserExecutionAuthorityPort = {
    [executionAuthorityBrand]: true,
    execute(
      request: BrowserExecutionRequest,
      context?: BrowserExecutionContext,
    ): Promise<BrowserExecutionResult> {
      return context === undefined
        ? delegate.execute(request)
        : delegate.execute(request, context);
    },
  };
  authorityRoots.set(port, root);
  return port;
}

export function assertIndependentBrowserExecutionAuthorities(
  executionPort: BrowserExecutionPort,
  verificationPort: BrowserExecutionPort,
): void {
  const executionRoot = authorityRoots.get(executionPort);
  const verificationRoot = authorityRoots.get(verificationPort);
  if (executionRoot === undefined
    || verificationRoot === undefined
    || executionRoot === verificationRoot) {
    throw new TypeError('IAG_INDEPENDENT_READ_BACK_PORT_REQUIRED');
  }
}
