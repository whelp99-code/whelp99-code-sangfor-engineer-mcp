import {
  browserExecutionRequestSchema,
  browserExecutionResultSchema,
  isAuthoritativePass,
  type BrowserExecutionPort,
  type BrowserExecutionResult,
} from '../../sangfor-browser-contracts/src/index.js';
import type { LocalJmExecutionOptions } from './types.js';

function refused(
  requestId: string,
  code: string,
  message: string,
): BrowserExecutionResult {
  return {
    schemaVersion: 'browser-execution-result.v1',
    requestId,
    status: 'REFUSED',
    mutationAttempted: false,
    evidence: [],
    error: { code, message },
  };
}

function normalizeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function mayHaveMutated(
  request: import('../../sangfor-browser-contracts/src/index.js').BrowserExecutionRequest,
): boolean {
  return request.operation.kind === 'perform_console_action'
    && request.operation.action.dryRun === false
    && ['click', 'type', 'select'].includes(request.operation.action.type);
}

export function createLocalJmExecutionPort(
  options: LocalJmExecutionOptions,
): BrowserExecutionPort {
  return {
    async execute(rawRequest) {
      const parsed = browserExecutionRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return refused(
          typeof rawRequest?.requestId === 'string'
            ? rawRequest.requestId
            : 'invalid-request',
          'INVALID_BROWSER_REQUEST',
          parsed.error.issues.map((issue) => issue.message).join('; '),
        );
      }

      const request = parsed.data;
      const session = options.resolveSession(request.sessionId);
      if (!session) {
        return refused(
          request.requestId,
          'SESSION_NOT_FOUND',
          `Local JM session ${request.sessionId} does not exist.`,
        );
      }

      const sessionOrigin = normalizeOrigin(session.origin);
      if (!sessionOrigin || sessionOrigin !== request.origin) {
        return refused(
          request.requestId,
          'SESSION_ORIGIN_MISMATCH',
          `Request origin ${request.origin} does not match local session origin.`,
        );
      }

      if (request.operation.kind === 'close_session') {
        await options.driver.closeSession(session);
        return {
          schemaVersion: 'browser-execution-result.v1',
          requestId: request.requestId,
          status: 'PASS',
          mutationAttempted: false,
          readBack: { status: 'PASS' },
          evidence: [],
        };
      }

      try {
        const result = browserExecutionResultSchema.parse(
          await options.driver.execute(session, request),
        );
        if (result.requestId !== request.requestId) {
          return refused(
            request.requestId,
            'RESULT_REQUEST_MISMATCH',
            `Driver returned result for ${result.requestId}.`,
          );
        }
        if (result.status === 'PASS' && !isAuthoritativePass(result)) {
          return {
            ...result,
            status: 'INDETERMINATE',
            error: result.error ?? {
              code: 'READ_BACK_INDETERMINATE',
              message: 'PASS requires an explicit PASS read-back.',
            },
          };
        }
        return result;
      } catch (error) {
        const mutationAttempted = mayHaveMutated(request);
        return {
          schemaVersion: 'browser-execution-result.v1',
          requestId: request.requestId,
          status: mutationAttempted ? 'INDETERMINATE' : 'FAIL',
          mutationAttempted,
          ...(mutationAttempted ? { readBack: { status: 'INDETERMINATE' as const } } : {}),
          evidence: [],
          error: {
            code: mutationAttempted
              ? 'JM_BROWSER_MUTATION_INDETERMINATE'
              : 'JM_BROWSER_DRIVER_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}
