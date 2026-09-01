import { z } from 'zod';
import { parseRuntimeJson, type RuntimeCodec } from '../../shared/src/runtime-schema.js';
import type { MaturityPolicy, SafetyPolicy } from './index.js';

const idSchema = z.string().min(1).max(512);
const textSchema = z.string().max(1_000_000);
const safetyEntrySchema = z.object({
  product: idSchema,
  capabilityId: idSchema,
  safetyClass: z.enum(['auto_allowed', 'read_only', 'human_only']),
  reason: textSchema,
}).strict();
const maturityEntrySchema = z.object({
  product: idSchema,
  capabilityId: idSchema,
  maturity: z.enum(['planned', 'implemented_local', 'tested_mock', 'field_verified']),
  evidence: textSchema,
}).strict();
const safetyPolicySchema: RuntimeCodec<SafetyPolicy> = z.object({
  version: z.literal(1),
  defaultSafetyClass: z.enum(['auto_allowed', 'read_only', 'human_only']),
  entries: z.array(safetyEntrySchema).max(100_000),
}).strict();
const maturityPolicySchema: RuntimeCodec<MaturityPolicy> = z.object({
  version: z.literal(1),
  entries: z.array(maturityEntrySchema).max(100_000),
}).strict();

export function parseBoundarySafetyPolicyV1(source: string): SafetyPolicy {
  return parseRuntimeJson(source, {
    schema: safetyPolicySchema,
    schemaName: 'safety.policy.v1',
    policy: 'deny',
    expectedVersion: 1,
  });
}

export function parseBoundaryMaturityPolicyV1(source: string): MaturityPolicy {
  return parseRuntimeJson(source, {
    schema: maturityPolicySchema,
    schemaName: 'safety.maturity-policy.v1',
    policy: 'deny',
    expectedVersion: 1,
  });
}
