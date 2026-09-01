import { z } from 'zod';
import { runtimeJsonObjectSchema } from '../../../packages/shared/src/runtime-json-codecs.js';
import { parseRuntimeJson, type RuntimeCodec } from '../../../packages/shared/src/runtime-schema.js';
import type { ObserverProfile } from '../../../packages/sangfor-observer/src/index.js';

export type JsonRpcRequest = {
  readonly jsonrpc: '2.0';
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
};

export type SearchGapEvent = {
  readonly id: string;
  readonly ts: string;
  readonly query: string;
  readonly product?: string;
  readonly version?: string;
  readonly hitCount: number;
  readonly topScore?: number;
  readonly reason: 'no_hits' | 'low_score';
};

const idSchema = z.string().min(1).max(512);
const requestSchema: RuntimeCodec<JsonRpcRequest> = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().max(512), z.number().finite()]).optional(),
  method: z.string().min(1).max(512),
  params: runtimeJsonObjectSchema.optional(),
}).strict();

const searchGapSchema: RuntimeCodec<SearchGapEvent> = z.object({
  id: idSchema,
  ts: z.string().min(1).max(128),
  query: z.string().min(1).max(100_000),
  product: idSchema.optional(),
  version: z.string().max(256).optional(),
  hitCount: z.number().int().nonnegative(),
  topScore: z.number().finite().optional(),
  reason: z.enum(['no_hits', 'low_score']),
}).strict();

const observerProfileSchema: RuntimeCodec<ObserverProfile> = z.object({
  product: z.string().min(1).max(256),
  expectedOrigin: z.string().min(1).max(2_048),
  cdpPort: z.number().int().min(1).max(65_535),
  firmwareTruthId: z.string().min(1).max(512),
  deviceScope: z.string().min(1).max(512),
}).strict();

const observerProfileRegistrySchema = z.object({
  version: z.literal(1),
  profiles: z.array(observerProfileSchema).min(1).max(100),
}).strict().transform(({ profiles }) => profiles);

export function parseBoundaryMcpStdioRequestV1(source: string): JsonRpcRequest {
  return parseRuntimeJson(source, {
    schema: requestSchema,
    schemaName: 'mcp-server.json-rpc-request.v1',
    policy: 'deny',
  });
}

export function parseBoundaryMcpSearchGapLineV1(source: string): SearchGapEvent {
  return parseRuntimeJson(source, {
    schema: searchGapSchema,
    schemaName: 'mcp-server.search-gap-event.v1',
    policy: 'freeze',
  });
}

export function parseObserverProfilesEnvironment(source: string): readonly ObserverProfile[] {
  return parseRuntimeJson(source, {
    schema: observerProfileRegistrySchema,
    schemaName: 'mcp-server.observer-profile-registry.v1',
    policy: 'deny',
    expectedVersion: 1,
    maxBytes: 256 * 1_024,
    maxDepth: 3,
    maxNodes: 1_000,
    maxArrayLength: 100,
    maxObjectKeys: 6,
  });
}
