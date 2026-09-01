import type { BrowserExecutionResult } from '../../packages/sangfor-browser-contracts/src/index.js';
import type {
  ExecutionPreflight,
  JmExecutionPort,
} from '../../packages/sangfor-jm-agent/src/index.js';

export type FakeExecutionPort = JmExecutionPort & {
  readonly calls: () => number;
  readonly closes: () => number;
};

/**
 * TESTS ONLY. Travels the same typed JmExecutionPort seam production uses, so a
 * test never takes a different runtime path. It lives here and is not importable
 * by the app or the package.
 */
export function createFakeExecutionPort(options: {
  readonly hold?: () => Promise<void>;
  readonly ignoreAbort?: boolean;
  /** Drives the SAME ongoing seam production readiness calls. */
  readonly preflight?: () => ExecutionPreflight;
  /** Drives the SAME startup seam, including the bind probe. */
  readonly startupPreflight?: (bind: { readonly host: string; readonly port: number })
    => Promise<ExecutionPreflight>;
} = {}): FakeExecutionPort {
  let calls = 0;
  let closes = 0;
  return {
    calls: () => calls,
    closes: () => closes,
    // Both phases exist on the fake exactly as they do in production.
    startupPreflight: async (bind) => (options.startupPreflight
      ? options.startupPreflight(bind)
      : options.preflight?.() ?? { ok: true }),
    readinessPreflight: () => options.preflight?.() ?? { ok: true },
    async execute(request, context): Promise<BrowserExecutionResult> {
      calls += 1;
      if (options.hold) await options.hold();
      if (context.signal.aborted && !options.ignoreAbort) {
        return {
          schemaVersion: 'browser-execution-result.v1',
          requestId: request.requestId,
          status: 'INDETERMINATE',
          mutationAttempted: true,
          readBack: { status: 'INDETERMINATE' },
          observations: {},
          evidence: [],
          error: { code: 'JM_EXECUTION_ABORTED', message: 'Aborted before completion.' },
        };
      }
      return {
        schemaVersion: 'browser-execution-result.v1',
        requestId: request.requestId,
        status: 'INDETERMINATE',
        mutationAttempted: false,
        readBack: { status: 'INDETERMINATE' },
        observations: {},
        evidence: [],
        error: { code: 'JM_FAKE_EXECUTION', message: 'Fake executor asserts no outcome.' },
      };
    },
    async close(): Promise<void> {
      closes += 1;
    },
  };
}
