import { RuntimeSchemaError, type RuntimeFailurePolicy } from '../../shared/src/runtime-schema.js';
import type { RuntimeJsonValue } from '../../shared/src/runtime-json-codecs.js';
import { parseBoundaryJmCdpMessageV1 } from './runtime-boundaries.js';

export type CdpFrame =
  | { readonly kind: 'result'; readonly id: number; readonly value: RuntimeJsonValue }
  | { readonly kind: 'error'; readonly id: number; readonly code: number; readonly message: string }
  | { readonly kind: 'event'; readonly method: string; readonly params: Readonly<Record<string, RuntimeJsonValue>> };

export type CdpEventFrame = Extract<CdpFrame, { kind: 'event' }>;

/**
 * A frame the boundary cannot classify leaves every in-flight command without
 * a verdict: the peer may have executed it, or not. Callers get this instead of
 * an empty success so the ambiguity reaches them intact.
 */
export class CdpIndeterminateError extends Error {
  readonly name = 'CdpIndeterminateError';

  readonly policy: RuntimeFailurePolicy = 'INDETERMINATE';

  constructor(cause: RuntimeSchemaError) {
    super(`CDP_RESPONSE_INDETERMINATE: ${cause.message}`, { cause });
  }
}

export type CdpDelivery =
  | { readonly kind: 'frame'; readonly frame: CdpFrame }
  | { readonly kind: 'indeterminate'; readonly error: CdpIndeterminateError };

export function classifyCdpFrame(data: string): CdpDelivery {
  try {
    return { kind: 'frame', frame: parseBoundaryJmCdpMessageV1(data) };
  } catch (error) {
    if (error instanceof RuntimeSchemaError) {
      return { kind: 'indeterminate', error: new CdpIndeterminateError(error) };
    }
    throw error;
  }
}
