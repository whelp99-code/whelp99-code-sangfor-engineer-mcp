import { isAbsolute, win32 } from 'node:path';
import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._()+-]{0,127}$/u;
export const MAX_TARGET_WORK_ATOMS = 20 as const;

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'must be lowercase SHA-256 hex').brand('Sha256');
export const evidenceIdSchema = z.string()
  .regex(ID_PATTERN, 'must be an opaque identifier')
  .refine((value) => value !== '.' && value !== '..' && !value.includes('..'), 'must not contain traversal')
  .brand('EvidenceId');
export const firmwareValueSchema = z.string()
  .regex(SAFE_VERSION_PATTERN, 'must be a bounded firmware value')
  .brand('FirmwareValue');
export const timestampSchema = z.string()
  .datetime({ offset: false, precision: 3 })
  .refine((value) => new Date(value).toISOString() === value, 'must be a canonical UTC timestamp')
  .brand('EvidenceTimestamp');
export const relativeArtifactPathSchema = z.string()
  .min(1)
  .max(512)
  .refine((value) => value === value.normalize('NFC'), 'must use NFC normalization')
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value), 'must be a clean relative path')
  .refine((value) => !isAbsolute(value) && !win32.isAbsolute(value) && !/^[A-Za-z]:/u.test(value), 'must be relative')
  .refine(
    (value) => value.split(/[\\/]/u).every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'must not contain traversal or empty segments',
  )
  .brand('RelativeArtifactPath');
export const mediaTypeSchema = z.string().regex(MEDIA_TYPE_PATTERN, 'must be a media type').brand('EvidenceMediaType');

export const actorIdentitySchema = z.object({
  actorId: evidenceIdSchema,
  actorType: z.enum(['human_pm', 'ai_engineer', 'service']),
}).strict().readonly();

export const capabilityTargetSchema = z.object({
  productId: evidenceIdSchema,
  capabilityId: evidenceIdSchema,
  toolId: evidenceIdSchema,
  workAtomIds: z.array(evidenceIdSchema).min(1).max(MAX_TARGET_WORK_ATOMS).readonly(),
}).strict().superRefine((target, context) => {
  const seen = new Set<string>();
  target.workAtomIds.forEach((id, index) => {
    if (seen.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['workAtomIds', index], message: 'duplicate WorkAtom id' });
    seen.add(id);
  });
}).readonly();

export type ActorIdentity = z.infer<typeof actorIdentitySchema>;
export type CapabilityTarget = z.infer<typeof capabilityTargetSchema>;
