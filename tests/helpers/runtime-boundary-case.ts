import { RuntimeSchemaError, type RuntimeFailurePolicy } from '../../packages/shared/src/runtime-schema.js';

export const REJECTED_RUNTIME_SECRET = 'customer-token-DO-NOT-ECHO';

export function captureRuntimeSchemaError(action: () => unknown): RuntimeSchemaError {
  try {
    action();
  } catch (error) {
    if (error instanceof RuntimeSchemaError) return error;
    throw error;
  }
  throw new Error('Expected RuntimeSchemaError');
}

export type RuntimeBoundaryCase = {
  readonly id: string;
  readonly policy: RuntimeFailurePolicy;
  readonly schemaName: string;
  readonly parse: (source: string) => unknown;
  readonly valid: unknown;
  readonly invalid: unknown;
};
