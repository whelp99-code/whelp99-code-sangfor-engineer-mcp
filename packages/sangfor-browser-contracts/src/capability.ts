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
} from './browser-execution.js';
import { jobEnvelopeSchema, type JobEnvelope } from './job-envelope.js';

export const JOB_CAPABILITY_VERSION = 'browser-job-capability.v1' as const;
export const JOB_CAPABILITY_ERROR_CODES = {
  ACTION_MISMATCH: 'CAPABILITY_ACTION_MISMATCH',
  EXPIRED: 'CAPABILITY_EXPIRED',
  EXPIRY_INVALID: 'CAPABILITY_EXPIRY_INVALID',
  FORMAT_INVALID: 'CAPABILITY_FORMAT_INVALID',
  IDENTITY_MISMATCH: 'CAPABILITY_IDENTITY_MISMATCH',
  NOT_YET_VALID: 'CAPABILITY_NOT_YET_VALID',
  REPLAYED: 'CAPABILITY_REPLAYED',
  SCOPE_MISMATCH: 'CAPABILITY_SCOPE_MISMATCH',
  SIGNATURE_INVALID: 'CAPABILITY_SIGNATURE_INVALID',
  SIGNING_KEY_INVALID: 'CAPABILITY_SIGNING_KEY_INVALID',
  VERIFY_KEY_INVALID: 'CAPABILITY_VERIFY_KEY_INVALID',
} as const;
export type JobCapabilityErrorCode =
  (typeof JOB_CAPABILITY_ERROR_CODES)[keyof typeof JOB_CAPABILITY_ERROR_CODES];

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
  readonly publicKey: CapabilityKey;
  readonly now?: Date;
}
export interface VerifyAndConsumeJobCapabilityInput extends VerifyJobCapabilityInput {
  readonly installationId: string;
  readonly clientIdentityId: string;
  readonly nonceStore: CapabilityNonceStore;
}

export class JobCapabilityError extends Error {
  override readonly name = 'JobCapabilityError';
  constructor(readonly code: JobCapabilityErrorCode, options?: ErrorOptions) {
    super(code, options);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.FORMAT_INVALID);
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}

export function browserExecutionRequestDigest(request: BrowserExecutionRequest): string {
  const parsed = browserExecutionRequestSchema.parse(request);
  return createHash('sha256').update(canonical(parsed)).digest('hex');
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function privateKeyObject(key: CapabilityKey): KeyObject {
  try {
    const object = key instanceof KeyObject ? key : createPrivateKey(key);
    if (object.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 key required.');
    return object;
  } catch (error) {
    if (error instanceof Error) {
      throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.SIGNING_KEY_INVALID, { cause: error });
    }
    throw error;
  }
}

function publicKeyObject(key: CapabilityKey): KeyObject {
  try {
    const object = key instanceof KeyObject
      ? (key.type === 'private' ? createPublicKey(key) : key)
      : createPublicKey(key);
    if (object.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 key required.');
    return object;
  } catch (error) {
    if (error instanceof Error) {
      throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.VERIFY_KEY_INVALID, { cause: error });
    }
    throw error;
  }
}

export function mintJobCapability(input: MintJobCapabilityInput): string {
  const request = browserExecutionRequestSchema.parse(input.request);
  if (input.expiresAt.getTime() <= input.issuedAt.getTime()) {
    throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.EXPIRY_INVALID);
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
    requestHash: browserExecutionRequestDigest(request),
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    jti: input.jti,
  });
  const payload = encode(canonical(claim));
  const signature = sign(
    null,
    Buffer.from(payload, 'utf8'),
    privateKeyObject(input.privateKey),
  ).toString('base64url');
  return `${payload}.${signature}`;
}

export function verifyJobCapability(input: VerifyJobCapabilityInput): JobCapabilityClaim {
  const envelope = jobEnvelopeSchema.parse(input.envelope);
  const parts = envelope.capability.split('.');
  const payload = parts[0];
  const suppliedSignature = parts[1];
  if (parts.length !== 2 || !payload || !suppliedSignature) {
    throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.FORMAT_INVALID);
  }
  const valid = verify(
    null,
    Buffer.from(payload, 'utf8'),
    publicKeyObject(input.publicKey),
    Buffer.from(suppliedSignature, 'base64url'),
  );
  if (!valid) throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.SIGNATURE_INVALID);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (error) {
    if (error instanceof Error) {
      throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.FORMAT_INVALID, { cause: error });
    }
    throw error;
  }
  const parsedClaim = capabilityClaimSchema.safeParse(decoded);
  if (!parsedClaim.success) {
    throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.FORMAT_INVALID, { cause: parsedClaim.error });
  }
  const claim = parsedClaim.data;
  const now = (input.now ?? new Date()).getTime();
  if (Date.parse(claim.expiresAt) <= now) throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.EXPIRED);
  if (Date.parse(claim.issuedAt) > now) throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.NOT_YET_VALID);
  if (claim.tenantId !== envelope.tenantId || claim.projectId !== envelope.projectId
    || claim.runId !== envelope.runId || claim.stepId !== envelope.stepId || claim.jobId !== envelope.jobId) {
    throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.SCOPE_MISMATCH);
  }
  if (claim.origin !== envelope.request.origin
    || claim.requestHash !== browserExecutionRequestDigest(envelope.request)) {
    throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.ACTION_MISMATCH);
  }
  return claim;
}

export async function verifyAndConsumeJobCapability(
  input: VerifyAndConsumeJobCapabilityInput,
): Promise<JobCapabilityClaim> {
  const claim = verifyJobCapability(input);
  if (claim.installationId !== input.installationId || claim.clientIdentityId !== input.clientIdentityId) {
    throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.IDENTITY_MISMATCH);
  }
  if (!await input.nonceStore.consume(claim.jti, claim.expiresAt)) {
    throw new JobCapabilityError(JOB_CAPABILITY_ERROR_CODES.REPLAYED);
  }
  return claim;
}
