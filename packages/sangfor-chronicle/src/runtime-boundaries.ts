import { z } from 'zod';
import { runtimeJsonObjectSchema, runtimeJsonValueSchema } from '../../shared/src/runtime-json-codecs.js';
import { parseRuntimeJson, type RuntimeCodec } from '../../shared/src/runtime-schema.js';
import type { ChronicleChain, ChronicleSnapshot } from './store.js';
import type { SemanticChange } from './diff.js';

const idSchema = z.string().min(1).max(512);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().min(1).max(128);

const semanticChangeSchema: RuntimeCodec<SemanticChange> = z.object({
  key: z.string().min(1).max(4_096),
  before: runtimeJsonValueSchema.optional(),
  after: runtimeJsonValueSchema.optional(),
  changeClass: z.enum(['added', 'removed', 'changed']),
}).strict();

const snapshotSchema: RuntimeCodec<ChronicleSnapshot> = z.object({
  hash: hashSchema,
  parentHash: hashSchema.optional(),
  deviceId: idSchema,
  capturedAt: timestampSchema,
  observed: runtimeJsonObjectSchema,
  ephemeralKeys: z.array(z.string().min(1).max(4_096)).max(100_000),
  canonical: z.string().max(64 * 1024 * 1024),
  diff: z.array(semanticChangeSchema).max(100_000),
}).strict();

const chainSchema: RuntimeCodec<ChronicleChain> = z.object({
  deviceId: idSchema,
  headHash: hashSchema.optional(),
  snapshots: z.array(snapshotSchema).max(100_000),
}).strict();

export function parseBoundaryChronicleCanonicalV1(source: string): Record<string, unknown> {
  return parseRuntimeJson(source, {
    schema: runtimeJsonObjectSchema,
    schemaName: 'chronicle.canonical-observation.v1',
    policy: 'loud_failure',
  });
}

export function parseBoundaryChronicleChainV1(source: string): ChronicleChain {
  return parseRuntimeJson(source, {
    schema: chainSchema,
    schemaName: 'chronicle.chain.v1',
    policy: 'freeze',
    uniqueCollections: [{ path: ['snapshots'], key: 'hash' }],
  });
}
