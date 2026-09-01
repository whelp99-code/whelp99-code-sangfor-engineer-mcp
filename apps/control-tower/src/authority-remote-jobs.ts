import { createHash, createPublicKey, X509Certificate, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  createBlroRemoteDispatcher,
  createNodeBlroJmTransport,
  signJmAuthorityArtifact,
  type PostgresRemoteJobStore,
} from '../../../packages/sangfor-authority/src/index.js';
import {
  leafCertificateSchema,
  type BrowserExecutionResult,
} from '../../../packages/sangfor-browser-contracts/src/index.js';

const idSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+=/-]*$/u)
  .refine((value) => !value.includes('..'));
const dispatchInputSchema = z.object({
  purpose: z.enum(['mutation', 'verification']),
  bodyText: z.string().min(1).max(64 * 1024),
  target: z.object({
    installationId: idSchema,
    clientIdentityId: idSchema,
    deviceBindingDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    origin: z.string().url().transform((value) => new URL(value).origin),
    certificate: leafCertificateSchema,
    environment: z.enum(['lab', 'poc', 'production']),
  }).strict(),
}).strict().readonly();

export interface AuthorityRemoteJobApi {
  submit(input: unknown): Promise<BrowserExecutionResult>;
}

export type AuthorityRemoteJobEnvironment = Readonly<Record<string, string | undefined>>;

export type AuthorityRemoteJobFactoryInput = {
  readonly environment: AuthorityRemoteJobEnvironment;
  readonly tenantId: string;
  readonly projectId: string;
  readonly signingPrivateKey: KeyObject;
  readonly jobStore: PostgresRemoteJobStore;
};

export function createOptionalAuthorityRemoteJobApi(
  input: AuthorityRemoteJobFactoryInput,
): AuthorityRemoteJobApi | undefined {
  return input.environment.SANGFOR_REMOTE_BROWSER_URL?.trim()
    ? createAuthorityRemoteJobApi(input)
    : undefined;
}

function createAuthorityRemoteJobApi(
  input: AuthorityRemoteJobFactoryInput,
): AuthorityRemoteJobApi {
  const endpointUrl = required(input.environment, 'SANGFOR_REMOTE_BROWSER_URL');
  const clientCertificate = readRequired(input.environment, 'SANGFOR_REMOTE_BROWSER_CLIENT_CERT_PATH');
  const tls = {
    cert: clientCertificate,
    key: readRequired(input.environment, 'SANGFOR_REMOTE_BROWSER_CLIENT_KEY_PATH'),
    ca: readRequired(input.environment, 'SANGFOR_REMOTE_BROWSER_CA_CERT_PATH'),
    expectedServerFingerprint256: required(input.environment, 'SANGFOR_REMOTE_BROWSER_SERVER_FINGERPRINT_SHA256'),
    ...(input.environment.SANGFOR_REMOTE_BROWSER_SERVER_NAME?.trim()
      ? { servername: input.environment.SANGFOR_REMOTE_BROWSER_SERVER_NAME.trim() }
      : {}),
  };
  const capabilityPublicKey = createPublicKey(input.signingPrivateKey);
  const keyDigest = createHash('sha256')
    .update(capabilityPublicKey.export({ format: 'der', type: 'spki' })).digest('hex');
  const clientFingerprint = new X509Certificate(clientCertificate)
    .fingerprint256.replaceAll(':', '').toLowerCase();
  const dispatcher = createBlroRemoteDispatcher({
    authority: input.jobStore,
    transport: createNodeBlroJmTransport({ tls, timeoutMs: 30_000 }),
    executionPolicy: {
      allowRealExecution: input.environment.SANGFOR_ALLOW_REAL_EXECUTION === 'true',
      allowProductionExecution: input.environment.SANGFOR_ALLOW_PRODUCTION_EXECUTION === 'true',
    },
    receiptSigner: {
      sign: (artifact) => signJmAuthorityArtifact(artifact, input.signingPrivateKey),
      keyId: required(input.environment, 'SANGFOR_REMOTE_BROWSER_CAPABILITY_KEY_ID'),
      keyDigest,
      clientCertificateFingerprintSha256: clientFingerprint,
      now: () => new Date(),
    },
  });
  return {
    async submit(raw: unknown): Promise<BrowserExecutionResult> {
      const parsed = dispatchInputSchema.parse(raw);
      return dispatcher.submit({
        purpose: parsed.purpose,
        bodyText: parsed.bodyText,
        target: {
          tenantId: input.tenantId, projectId: input.projectId,
          endpointUrl, ...parsed.target,
        },
      });
    },
  };
}

function required(environment: AuthorityRemoteJobEnvironment, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new AuthorityRemoteJobConfigError(key);
  return value;
}

function readRequired(environment: AuthorityRemoteJobEnvironment, key: string): Buffer {
  return readFileSync(required(environment, key));
}

class AuthorityRemoteJobConfigError extends Error {
  override readonly name = 'AuthorityRemoteJobConfigError';
  constructor(readonly field: string) { super('BLRO remote job configuration is invalid.'); }
}
