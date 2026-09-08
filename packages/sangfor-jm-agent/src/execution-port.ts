import type {
  BrowserExecutionPort,
  BrowserExecutionRequest,
  BrowserExecutionResult,
} from '@sangfor/browser-contracts';

/**
 * The single seam through which the agent reaches a browser.
 *
 * Production supplies the operated `@sangfor/jm-execution` port; tests supply a
 * fake. Both travel this identical typed injection, so a test never exercises a
 * different code path than production does. There is no "mock mode" branch in
 * the runtime for a test to take.
 */
export const EXECUTION_PREFLIGHT_REFUSALS = {
  CHROMIUM_MISSING: 'EXECUTION_CHROMIUM_MISSING',
  CHROMIUM_NOT_EXECUTABLE: 'EXECUTION_CHROMIUM_NOT_EXECUTABLE',
  PROFILE_MISSING: 'EXECUTION_PROFILE_MISSING',
  PROFILE_INSECURE: 'EXECUTION_PROFILE_INSECURE',
  PORT_UNAVAILABLE: 'EXECUTION_PORT_UNAVAILABLE',
  DRIVER_UNAVAILABLE: 'EXECUTION_DRIVER_UNAVAILABLE',
} as const;

export type ExecutionPreflightRefusal =
  (typeof EXECUTION_PREFLIGHT_REFUSALS)[keyof typeof EXECUTION_PREFLIGHT_REFUSALS];

export type ExecutionPreflight =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ExecutionPreflightRefusal };

export interface JmExecutionPort {
  /**
   * Startup phase. Runs EXACTLY ONCE before the TLS listener is created and
   * additionally proves the loopback bind by actually binding a probe socket.
   * A bind-probe failure means no listener is ever created.
   */
  startupPreflight(bind: { readonly host: string; readonly port: number }):
    Promise<ExecutionPreflight>;
  /**
   * Ongoing phase, called by /ready. Re-validates the executable, the profile
   * and the execution port WITHOUT rebinding the service's own listening port,
   * which is already held by the running listener.
   */
  readinessPreflight(): ExecutionPreflight;
  execute(
    request: BrowserExecutionRequest,
    context: { readonly signal: AbortSignal; readonly deadline: string },
  ): Promise<BrowserExecutionResult>;
  /** Releases browser/profile resources. Must be safe to call more than once. */
  close(): Promise<void>;
}

export type JmExecutionPortFactory = () => Promise<JmExecutionPort>;

/**
 * Adapts a JmExecutionPort to the transport-facing BrowserExecutionPort while
 * enforcing the server-owned job deadline. The controller is registered so a
 * drain deadline can abort work that is still running.
 */
export function toBrowserExecutionPort(
  port: JmExecutionPort,
  options: {
    readonly jobTimeoutMs: number;
    readonly registerController: (controller: AbortController) => () => void;
    readonly now: () => Date;
  },
): BrowserExecutionPort {
  return {
    async execute(request, context) {
      const controller = new AbortController();
      const release = options.registerController(controller);
      const timeout = AbortSignal.timeout(options.jobTimeoutMs);
      const onTimeout = (): void => controller.abort(new Error('JM_JOB_DEADLINE_EXCEEDED'));
      const onTransport = (): void => controller.abort(new Error('JM_TRANSPORT_ABORTED'));
      timeout.addEventListener('abort', onTimeout, { once: true });
      context?.signal.addEventListener('abort', onTransport, { once: true });
      try {
        return await port.execute(request as BrowserExecutionRequest, {
          signal: controller.signal,
          deadline: new Date(options.now().getTime() + options.jobTimeoutMs).toISOString(),
        });
      } finally {
        timeout.removeEventListener('abort', onTimeout);
        context?.signal.removeEventListener('abort', onTransport);
        release();
      }
    },
  };
}
