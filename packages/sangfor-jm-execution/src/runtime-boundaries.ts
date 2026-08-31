import { z } from 'zod';
import { runtimeJsonObjectSchema, runtimeJsonValueSchema } from '../../shared/src/runtime-json-codecs.js';
import { parseRuntimeJson } from '../../shared/src/runtime-schema.js';
import type { CdpFrame } from './cdp-frame.js';

const frameIdSchema = z.number().int().positive();
const ownedCdpProfileSchema = z.object({
  profileRef: z.string().min(1).max(512),
  cdpPort: z.number().int().min(1).max(65_535),
  expectedOrigin: z.string().min(1).max(2_048),
}).strict();
const ownedCdpProfileRegistrySchema = z.array(ownedCdpProfileSchema).max(100);

// A CDP frame is exactly one of three things: a reply carrying a result, a
// reply carrying an error, or an event. Overlaps (a reply with both outcomes,
// a reply with neither, a frame that is both reply and event) are not frames
// this transport can act on — the union refuses them so that no waiting call
// is ever handed a fabricated empty result.
const cdpFrameSchema = z.union([
  z.object({
    id: frameIdSchema,
    result: runtimeJsonValueSchema,
  }).strict().transform((frame) => ({ kind: 'result', id: frame.id, value: frame.result }) as const),
  z.object({
    id: frameIdSchema,
    error: z.object({
      code: z.number().int(),
      message: z.string().min(1).max(1_000_000),
    }).strict(),
  }).strict().transform((frame) => ({
    kind: 'error',
    id: frame.id,
    code: frame.error.code,
    message: frame.error.message,
  }) as const),
  z.object({
    method: z.string().min(1).max(512),
    params: runtimeJsonObjectSchema.optional(),
  }).strict().transform((frame) => ({
    kind: 'event',
    method: frame.method,
    params: frame.params ?? {},
  }) as const),
]);

export function parseBoundaryJmCdpMessageV1(source: string): CdpFrame {
  return parseRuntimeJson(source, {
    schema: cdpFrameSchema,
    schemaName: 'jm-execution.cdp-message.v1',
    policy: 'INDETERMINATE',
  });
}

export function parseOwnedCdpProfilesEnvironment(
  source: string,
): z.output<typeof ownedCdpProfileRegistrySchema> {
  return parseRuntimeJson(source, {
    schema: ownedCdpProfileRegistrySchema,
    schemaName: 'jm-execution.owned-cdp-profile-registry.v1',
    policy: 'deny',
    maxBytes: 256 * 1_024,
    maxDepth: 2,
    maxNodes: 500,
    maxArrayLength: 100,
    maxObjectKeys: 3,
  });
}
