import {
  parseRuntimeJson,
  type RuntimeCodec,
} from '../../packages/shared/src/runtime-schema.js';

export function parseBoundaryStrategyCliInputV1<TOutput, TInput>(
  source: string,
  codec: RuntimeCodec<TOutput, TInput>,
): TOutput {
  return parseRuntimeJson(source, {
    schema: codec,
    schemaName: 'learning-operations.strategy-cli-input.v1',
    policy: 'loud_failure',
  });
}
