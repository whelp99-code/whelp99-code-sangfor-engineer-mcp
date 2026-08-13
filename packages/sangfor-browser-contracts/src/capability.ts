import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from 'node:crypto';
import { z } from 'zod';
import {
  browserExecutionRequestSchema,
  type BrowserExecutionRequest,
  type JsonValue,
} from './browser-execution.js';
import { jobEnvelopeSchema, type JobEnvelope } from './job-envelope.js';

export const JOB_CAPABILITY_VERSION = 'browser-job-capability.v1' as const;

const idSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u)
  .refine((value) => !value.includes('..'));
const capabilityClaimSchema = z.object({
  version: z.literal(JOB_CAPABILITY_VERSION),
  tenantId: idSchema,
  projectId: idSchema,
  runId: idSchema,
  stepId: idSchema,
  jobId: idSchema,
  clientIdentityId: idSchema,
  installationId: idSchema,
  origin: z.string().url(),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  jti: idSchema,
}).strict().readonly();

export type JobCapabilityClaim = z.infer<typeof capabilityClaimSchema>;
export type CapabilityKey = KeyObject | string | Buffer;

export interface CapabilityNonceStore {
  consume(jti: string, expiresAt: string): Promise<boolean>;
}

export interface MintJobCapabilityInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly jobId: string;
  readonly clientIdentityId: string;
  readonly installationId: string;
  readonly request: BrowserExecutionRequest;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly jti: string;
  readonly privateKey: CapabilityKey;
}

export interface VerifyJobCapabilityInput {
  readonly envelope: JobEnvelope;
  readonly installationId: string;
  readonly clientIdentityId: string;
  readonly publicKey: CapabilityKey;
  readonly nonceStore: CapabilityNonceStore;
  readonly now?: Date;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key] as JsonValue)}`
  )).join(',')}}`;
}

function requestHash(request: BrowserExecutionRequest): string {
  return createHash('sha256')
    .update(canonical(request as unknown as JsonValue))
    .digest('hex');
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw new Error('CAPABILITY_FORMAT_INVALID');
  }
}

function privateKeyObject(key: CapabilityKey): KeyObject {
  const object = key instanceof KeyObject ? key : createPrivateKey(key);
  if (object.asymmetricKeyType !== 'ed25519') {
    throw new Error('CAPABILITY_SIGNING_KEY_INVALID');
  }
  return object;
}

function publicKeyObject(key: CapabilityKey): KeyObject {
  const object = key instanceof KeyObject
    ? (key.type === 'private' ? createPublicKey(key) : key)
    : createPublicKey(key);
  if (object.asymmetricKeyType !== 'ed25519') {
    throw new Error('CAPABILITY_VERIFY_KEY_INVALID');
  }
  return object;
}

export function mintJobCapability(input: MintJobCapabilityInput): string {
  const request = browserExecutionRequestSchema.parse(input.request);
  if (input.expiresAt.getTime() <= input.issuedAt.getTime()) {
    throw new Error('CAPABILITY_EXPIRY_INVALID');
  }
  const claim = capabilityClaimSchema.parse({
    version: JOB_CAPABILITY_VERSION,
    tenantId: input.tenantId,
    projectId: input.projectId,
    runId: input.runId,
    stepId: input.stepId,
    jobId: input.jobId,
    clientIdentityId: input.clientIdentityId,
    installationId: input.installationId,
    origin: request.origin,
    requestHash: requestHash(request),
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    jti: input.jti,
  });
  const payload = encode(canonical(claim as unknown as JsonValue));
  const signature = sign(
    null,
    Buffer.from(payload, 'utf8'),
    privateKeyObject(input.privateKey),
  ).toString('base64url');
  return `${payload}.${signature}`;
}

export async function verifyAndConsumeJobCapability(
  input: VerifyJobCapabilityInput,
): Promise<JobCapabilityClaim> {
  const envelope = jobEnvelopeSchema.parse(input.envelope);
  const [payload, suppliedSignature, extra] = envelope.capability.split('.');
  if (!payload || !suppliedSignature || extra) {
    throw new Error('CAPABILITY_FORMAT_INVALID');
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(suppliedSignature, 'base64url');
  } catch {
    throw new Error('CAPABILITY_FORMAT_INVALID');
  }
  if (!verify(
    null,
    Buffer.from(payload, 'utf8'),
    publicKeyObject(input.publicKey),
    signature,
  )) {
    throw new Error('CAPABILITY_SIGNATURE_INVALID');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(decode(payload));
  } catch {
    throw new Error('CAPABILITY_FORMAT_INVALID');
  }
  const claim = capabilityClaimSchema.parse(decoded);
  const now = (input.now ?? new Date()).getTime();
  if (Date.parse(claim.expiresAt) <= now) throw new Error('CAPABILITY_EXPIRED');
  if (Date.parse(claim.issuedAt) > now) throw new Error('CAPABILITY_NOT_YET_VALID');
  if (
    claim.tenantId !== envelope.tenantId
    || claim.projectId !== envelope.projectId
    || claim.runId !== envelope.runId
    || claim.stepId !== envelope.stepId
    || claim.jobId !== envelope.jobId
  ) {
    throw new Error('CAPABILITY_SCOPE_MISMATCH');
  }
  if (
    claim.installationId !== input.installationId
    || claim.clientIdentityId !== input.clientIdentityId
  ) {
    throw new Error('CAPABILITY_IDENTITY_MISMATCH');
  }
  const request = browserExecutionRequestSchema.parse(envelope.request);
  if (claim.requestHash !== requestHash(request)) {
    throw new Error('CAPABILITY_ACTION_MISMATCH');
  }
  if (!await input.nonceStore.consume(claim.jti, claim.expiresAt)) {
    throw new Error('CAPABILITY_REPLAYED');
  }
  return claim;
}
