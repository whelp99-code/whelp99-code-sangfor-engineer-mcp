import {
  ActiveExecutions,
  createJmAgentRuntime,
  parseJmAgentConfig,
  toBrowserExecutionPort,
  type JmAgentConfig,
  type JmAgentConfigIssue,
  type JmAgentEnvironment,
  type JmAgentRuntime,
  type JmExecutionPort,
} from '../../../packages/sangfor-jm-agent/src/index.js';
import type { BrowserExecutionPort } from '../../../packages/sangfor-browser-contracts/src/index.js';
import { createOperatedExecutionPort } from './operated-execution.js';

export class JmAgentStartupError extends Error {
  override readonly name = 'JmAgentStartupError';
  constructor(readonly issues: readonly JmAgentConfigIssue[]) {
    super(`Refusing to start: ${issues.map((issue) => `${issue.field}=${issue.code}`).join(', ')}`);
  }
}

/** Per-job authority material the transport captures before dispatch. */
export type DispatchContext = {
  readonly receipt: string | undefined;
  readonly receiptId: string | undefined;
  readonly clientFingerprint: string | undefined;
};

export type JmAgentComposition = {
  readonly config: JmAgentConfig;
  readonly runtime: JmAgentRuntime;
  readonly executor: BrowserExecutionPort;
  readonly executionPort: JmExecutionPort;
  readonly active: ActiveExecutions;
  readonly dispatchContexts: Map<string, DispatchContext>;
};

export type ComposeOptions = {
  /**
   * The execution seam. Production omits it and gets the operated
   * `@sangfor/jm-execution` port; a test injects a fake through this identical
   * typed seam, so no test takes a different runtime path.
   */
  readonly executionPort?: JmExecutionPort;
  readonly now?: () => Date;
};

export function composeJmAgent(
  environment: JmAgentEnvironment,
  options: ComposeOptions = {},
): JmAgentComposition {
  const parsed = parseJmAgentConfig(environment);
  if (!parsed.success) throw new JmAgentStartupError(parsed.issues);
  const config = parsed.data;
  const now = options.now ?? (() => new Date());
  const executionPort = options.executionPort ?? createOperatedExecutionPort(config);
  const active = new ActiveExecutions();
  const dispatchContexts = new Map<string, DispatchContext>();
  // The transport keys material by the job header when BLRO sends one, and by
  // the wildcard otherwise; a single in-flight call resolves either way.
  const contextFor = (jobId: string): DispatchContext | undefined =>
    dispatchContexts.get(jobId) ?? dispatchContexts.get('*');
  const runtime = createJmAgentRuntime({
    config,
    executionPort,
    receiptFor: (jobId) => contextFor(jobId)?.receipt,
    receiptIdFor: (jobId) => contextFor(jobId)?.receiptId,
    clientFingerprintFor: (jobId) => contextFor(jobId)?.clientFingerprint,
    now,
  });
  return {
    config,
    runtime,
    executionPort,
    active,
    dispatchContexts,
    executor: toBrowserExecutionPort(executionPort, {
      jobTimeoutMs: config.jobTimeoutMs,
      registerController: (controller) => active.register(controller),
      now,
    }),
  };
}
