import { isIP } from 'node:net';
import { getDomain } from 'tldts';
import { z } from 'zod';

export const structuralSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u).brand('Sha256');

function namespacedId(prefix: string) {
  return z.string()
    .min(prefix.length + 1)
    .max(128)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9][A-Za-z0-9._:@+=-]*$`, 'u'))
    .refine((value) => !value.includes('..'), 'Identifier must not contain traversal segments.');
}

export const structuralOpaqueIdSchema = z.string()
  .min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+=-]*$/u)
  .refine((value) => !value.includes('..'));

export const structuralPlanIdSchema = namespacedId('plan-').brand('IagPlanId');
export const structuralTaskIdSchema = namespacedId('task-').brand('IagTaskId');
export const structuralCampaignIdSchema = structuralOpaqueIdSchema.brand('IagCampaignId');
export const structuralIdempotencyKeySchema = namespacedId('idem-').brand('IagIdempotencyKey');
export const structuralSessionIdSchema = structuralOpaqueIdSchema.brand('IagSessionId');
export const structuralVerifierSessionIdSchema = namespacedId('verifier-session-').brand('IagVerifierSessionId');
export const structuralWindowIdSchema = structuralOpaqueIdSchema.brand('IagWindowId');
export const structuralFirmwareIdSchema = namespacedId('firmware-').brand('IagFirmwareId');

function isRegistrableExceptionDomain(value: string): boolean {
  if (value.endsWith('.invalid')) return value.split('.').length >= 3;
  return getDomain(value, { allowPrivateDomains: true }) !== null;
}

export const structuralCanonicalHostSchema = z.string()
  .min(3).max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/u,
    'Value must be a registrable multi-label lowercase host/domain.',
  )
  .refine((value) => isIP(value) === 0, 'IP exception values are refused.')
  .refine(isRegistrableExceptionDomain, 'Public suffixes and non-registrable domains are refused.')
  .brand('CanonicalHost');

export const structuralApplicationIdSchema = z.string()
  .min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+=-]*$/u)
  .refine((value) => !value.includes('..'))
  .brand('IagApplicationId');

export const structuralActionBindingsSchema = z.object({
  planId: structuralPlanIdSchema,
  taskId: structuralTaskIdSchema,
  campaignId: structuralCampaignIdSchema,
  idempotencyKey: structuralIdempotencyKeySchema,
}).strict().readonly();

const firmwareValueSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u);

export const structuralFirmwareTruthSchema = z.object({
  recordId: structuralFirmwareIdSchema,
  vendor: z.literal('SANGFOR'),
  adapterProduct: z.literal('IAG'),
  productVariant: structuralOpaqueIdSchema.nullable(),
  versionRaw: firmwareValueSchema,
  versionFamily: firmwareValueSchema,
  revision: firmwareValueSchema.nullable(),
  buildId: firmwareValueSchema.nullable(),
  hotfix: firmwareValueSchema.nullable(),
  uiFingerprint: structuralSha256Schema.nullable(),
  apiFingerprint: structuralSha256Schema.nullable(),
  status: z.literal('verified'),
  observedAt: z.string().datetime({ offset: true }),
  specVersion: firmwareValueSchema,
  specApplicability: z.literal('verified'),
  truthDigest: structuralSha256Schema,
}).strict().readonly();

export const structuralImplementationDigestsSchema = z.object({
  recipeDigest: structuralSha256Schema,
  toolDigest: structuralSha256Schema,
  runtimeDigest: structuralSha256Schema,
}).strict().readonly();

export type IagActionBindings = z.infer<typeof structuralActionBindingsSchema>;
export type IagFirmwareTruth = z.infer<typeof structuralFirmwareTruthSchema>;
export type IagImplementationDigests = z.infer<typeof structuralImplementationDigestsSchema>;
