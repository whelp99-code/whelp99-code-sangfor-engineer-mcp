import { z } from 'zod';
import { canonicalizeAllowedOrigin, parseBlroSanUri } from './server-identity.js';

const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;

const idSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+=/-]*$/u)
  .refine((value) => !value.includes('..'));
const absolutePathSchema = z.string().trim().min(1).max(4096).startsWith('/');
const digestSchema = z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/u);
const boundedMs = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const jmAgentConfigSchema = z.object({
  bindHost: z.enum(LOOPBACK_HOSTS),
  // 0 requests an ephemeral loopback port; the loopback bind is the safety gate.
  port: z.coerce.number().int().min(0).max(65_535),
  tlsCertPath: absolutePathSchema,
  tlsKeyPath: absolutePathSchema,
  tlsClientCaPath: absolutePathSchema,
  blroClientFingerprintSha256: digestSchema,
  blroClientSubjectCn: z.string().trim().min(1).max(200),
  blroClientSerial: z.string().trim().min(1).max(80).regex(/^[0-9A-Fa-f]+$/u)
    .transform((value) => value.toUpperCase()),
  blroClientSanUri: z.string().trim().min(1).max(500)
    .refine((value) => parseBlroSanUri(value) !== undefined, 'Exact installation URN required.')
    .transform((value) => parseBlroSanUri(value) ?? value),
  blroClientIssuerCn: z.string().trim().min(1).max(200),
  verifyKeyRingPath: absolutePathSchema,
  grantSnapshotPath: absolutePathSchema,
  journalRoot: absolutePathSchema,
  tenantId: idSchema,
  projectId: idSchema,
  installationId: idSchema,
  deviceBindingDigest: digestSchema,
  // Operated browser execution inputs. There is no mock mode in production.
  browserProfileRef: idSchema,
  browserProfileRoot: absolutePathSchema,
  browserSessionId: idSchema,
  browserChromiumPath: absolutePathSchema,
  allowedOrigin: z.string().trim().min(1).max(2048)
    .refine((value) => canonicalizeAllowedOrigin(value) !== undefined,
      'An https origin without path, query, fragment or userinfo is required.')
    .transform((value) => canonicalizeAllowedOrigin(value) ?? value),
  jobTimeoutMs: boundedMs(1_000, 600_000),
  drainDeadlineMs: boundedMs(1, 600_000),
  snapshotMaxAgeMs: boundedMs(1_000, 86_400_000),
}).strict().readonly();

export type JmAgentConfig = z.infer<typeof jmAgentConfigSchema>;

export const JM_AGENT_CONFIG_FIELDS = {
  bindHost: 'SANGFOR_JM_AGENT_BIND_HOST',
  port: 'SANGFOR_JM_AGENT_PORT',
  tlsCertPath: 'SANGFOR_JM_AGENT_TLS_CERT_PATH',
  tlsKeyPath: 'SANGFOR_JM_AGENT_TLS_KEY_PATH',
  tlsClientCaPath: 'SANGFOR_JM_AGENT_TLS_CLIENT_CA_PATH',
  blroClientFingerprintSha256: 'SANGFOR_JM_AGENT_BLRO_CLIENT_FINGERPRINT_SHA256',
  blroClientSubjectCn: 'SANGFOR_JM_AGENT_BLRO_CLIENT_SUBJECT_CN',
  blroClientSerial: 'SANGFOR_JM_AGENT_BLRO_CLIENT_SERIAL',
  blroClientSanUri: 'SANGFOR_JM_AGENT_BLRO_CLIENT_SAN_URI',
  blroClientIssuerCn: 'SANGFOR_JM_AGENT_BLRO_CLIENT_ISSUER_CN',
  verifyKeyRingPath: 'SANGFOR_JM_AGENT_VERIFY_KEY_RING_PATH',
  grantSnapshotPath: 'SANGFOR_JM_AGENT_GRANT_SNAPSHOT_PATH',
  journalRoot: 'SANGFOR_JM_AGENT_JOURNAL_ROOT',
  tenantId: 'SANGFOR_JM_AGENT_TENANT_ID',
  projectId: 'SANGFOR_JM_AGENT_PROJECT_ID',
  installationId: 'SANGFOR_JM_AGENT_INSTALLATION_ID',
  deviceBindingDigest: 'SANGFOR_JM_AGENT_DEVICE_BINDING_DIGEST',
  browserProfileRef: 'SANGFOR_JM_AGENT_BROWSER_PROFILE_REF',
  browserProfileRoot: 'SANGFOR_JM_AGENT_BROWSER_PROFILE_ROOT',
  browserSessionId: 'SANGFOR_JM_AGENT_BROWSER_SESSION_ID',
  browserChromiumPath: 'SANGFOR_JM_AGENT_BROWSER_CHROMIUM_PATH',
  allowedOrigin: 'SANGFOR_JM_AGENT_ALLOWED_ORIGIN',
  jobTimeoutMs: 'SANGFOR_JM_AGENT_JOB_TIMEOUT_MS',
  drainDeadlineMs: 'SANGFOR_JM_AGENT_DRAIN_DEADLINE_MS',
  snapshotMaxAgeMs: 'SANGFOR_JM_AGENT_SNAPSHOT_MAX_AGE_MS',
} as const satisfies Readonly<Record<keyof JmAgentConfig, string>>;

export type JmAgentConfigField =
  (typeof JM_AGENT_CONFIG_FIELDS)[keyof typeof JM_AGENT_CONFIG_FIELDS];

export const JM_AGENT_CONFIG_KEYS = Object.keys(JM_AGENT_CONFIG_FIELDS) as
  readonly (keyof JmAgentConfig)[];

export const JM_AGENT_ENVIRONMENT_NAMES: readonly string[] =
  Object.values(JM_AGENT_CONFIG_FIELDS);

/**
 * Names that must never appear in a production environment. A leftover mock
 * switch is a deployment that silently does not touch a browser, so it is a
 * hard startup refusal rather than an ignored value.
 */
export const JM_AGENT_FORBIDDEN_FIELDS: readonly string[] = [
  'SANGFOR_JM_AGENT_EXECUTION_MODE',
  'SANGFOR_JM_AGENT_MOCK',
  'SANGFOR_JM_AGENT_MOCK_EXECUTION',
  'SANGFOR_JM_AGENT_USE_MOCK',
];

export type JmAgentEnvironment = Readonly<Partial<Record<JmAgentConfigField, string>>>;

export function isJmAgentConfigKey(value: string): value is keyof JmAgentConfig {
  return Object.hasOwn(JM_AGENT_CONFIG_FIELDS, value);
}
