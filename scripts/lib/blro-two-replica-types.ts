import { z } from 'zod';

export const replicaConfigSchema = z.object({
  identity: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  databaseUrl: z.string().url(),
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  installationId: z.string().min(1),
  clientIdentityId: z.string().min(1),
  deviceBindingDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  origin: z.string().url(),
  endpointUrl: z.string().url(),
  capabilityPublicKey: z.string().min(1),
  signingPrivateKey: z.string().min(1),
  trustedIssuerBundle: z.string().min(1),
  clientCertificate: z.string().min(1),
  clientCertificatePem: z.string().min(1),
  clientKeyPem: z.string().min(1),
  caPem: z.string().min(1),
  serverFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  keyId: z.string().min(1),
  keyDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  clientFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict().readonly();
export type ReplicaConfig = z.infer<typeof replicaConfigSchema>;

export const parentMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('submit'), id: z.string(), bodyText: z.string(),
    purpose: z.enum(['mutation', 'verification']),
    failpoint: z.enum(['none', 'pre_commit', 'post_commit']).default('none') }).strict(),
  z.object({ kind: z.literal('release'), id: z.string() }).strict(),
  z.object({ kind: z.literal('stop') }).strict(),
]);
export type ParentMessage = z.infer<typeof parentMessageSchema>;

export const childMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), identity: z.string(), pid: z.number().int(), port: z.number().int() }).strict(),
  z.object({ kind: z.literal('lifecycle'), id: z.string(), event: z.enum(['reserved', 'waiting', 'dispatch-boundary', 'result-retained']) }).strict(),
  z.object({ kind: z.literal('result'), id: z.string(), result: z.unknown() }).strict(),
  z.object({ kind: z.literal('failure'), id: z.string(), code: z.string() }).strict(),
]);
export type ChildMessage = z.infer<typeof childMessageSchema>;
