import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AUTHORITY_MIGRATIONS } from '../../packages/sangfor-authority/src/index.js';
import { REMOTE_BROWSER_JOB_PATH } from '../../packages/sangfor-browser-contracts/src/index.js';
import type { BaselineObservation, BaselineState } from './completeness-baseline.js';
import type { CollectorEnvironment } from './completeness-baseline-sources.js';

const PERSISTENCE_VARIABLES = ['DATABASE_URL', 'SANGFOR_BLRO_DATABASE_URL'] as const;
const AUTHORITY_VARIABLE = 'SANGFOR_BLRO_AUTHORITY_STORE';
const postgresUrlSchema = z.string().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'postgres:' || url.protocol === 'postgresql:')
    && url.hostname.length > 0
    && url.pathname.length > 1;
});
const authoritySchema = z.literal('postgres');

const observation = (
  environment: CollectorEnvironment,
  state: BaselineState,
  detail: string,
  data: unknown,
): BaselineObservation => ({
  sourceId: 'persistence_cutover',
  origin: `packages/sangfor-authority/src/migrations.ts + env:${PERSISTENCE_VARIABLES.join(',')},${AUTHORITY_VARIABLE}`,
  command: 'parse AUTHORITY_MIGRATIONS and redacted persistence/cutover environment',
  collectedAt: environment.collectedAt,
  state,
  detail,
  data,
});

export function collectPersistenceCutover(environment: CollectorEnvironment): BaselineObservation {
  const parsedUrls = PERSISTENCE_VARIABLES.map((name) => ({
    name,
    supplied: environment.env[name] !== undefined,
    valid: postgresUrlSchema.safeParse(environment.env[name]).success,
  }));
  const authority = environment.env[AUTHORITY_VARIABLE];
  const authorityValid = authoritySchema.safeParse(authority).success;
  const invalidVariables = [
    ...parsedUrls.filter((entry) => entry.supplied && !entry.valid).map((entry) => entry.name),
    ...(authority !== undefined && !authorityValid ? [AUTHORITY_VARIABLE] : []),
  ];
  const configuredVariables = parsedUrls.filter((entry) => entry.valid).map((entry) => entry.name);
  const data = {
    configuredVariables,
    invalidVariables,
    authorityMode: authorityValid ? 'blro_postgres' : 'jm_local',
    fileBackedStoresAuthoritative: !authorityValid,
    owners: AUTHORITY_MIGRATIONS,
  };

  if (invalidVariables.length > 0) {
    return observation(environment, 'FAIL', `${invalidVariables.length} persistence variable(s) are malformed`, data);
  }
  if (!authorityValid || configuredVariables.length === 0) {
    return observation(
      environment,
      'BLOCKED',
      authorityValid
        ? 'BLRO Postgres authority is selected without a persistence connection string'
        : 'JM-local authority remains selected; canonical BLRO owners are declared but cutover is not active',
      data,
    );
  }
  return observation(environment, 'PASS', 'BLRO Postgres authority and its connection are schema-valid', data);
}

export const WIRING_VARIABLES = [
  'SANGFOR_ALLOW_REAL_EXECUTION',
  'SANGFOR_ALLOW_PRODUCTION_EXECUTION',
  'SANGFOR_OPERATOR_APPROVAL_SECRET',
  'SANGFOR_TENANT_ID',
  'SANGFOR_PROJECT_ID',
  'SANGFOR_REMOTE_BROWSER_URL',
  'SANGFOR_REMOTE_BROWSER_CA_CERT_PATH',
  'SANGFOR_REMOTE_BROWSER_CLIENT_CERT_PATH',
  'SANGFOR_REMOTE_BROWSER_CLIENT_KEY_PATH',
  'SANGFOR_REMOTE_BROWSER_CAPABILITY_PRIVATE_KEY_PATH',
  'SANGFOR_REMOTE_BROWSER_CLIENT_IDENTITY_ID',
  'SANGFOR_REMOTE_BROWSER_INSTALLATION_ID',
  'SANGFOR_REMOTE_BROWSER_SERVER_FINGERPRINT_SHA256',
] as const;

type WiringVariable = (typeof WIRING_VARIABLES)[number];

const exactSecretSchema = z.string().min(1).max(4096).refine((value) => value === value.trim());
const scopeIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u);
const opaqueIdSchema = z.string().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+=-]*$/u)
  .refine((value) => !value.includes('..'));
const endpointSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.pathname === REMOTE_BROWSER_JOB_PATH;
});
const absolutePathSchema = z.string().refine(isAbsolute);
const fingerprintSchema = z.string().regex(/^(?:[a-fA-F0-9]{64}|(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2})$/u);

const WIRING_SCHEMAS = {
  SANGFOR_ALLOW_REAL_EXECUTION: z.literal('true'),
  SANGFOR_ALLOW_PRODUCTION_EXECUTION: z.literal('true'),
  SANGFOR_OPERATOR_APPROVAL_SECRET: exactSecretSchema,
  SANGFOR_TENANT_ID: scopeIdSchema,
  SANGFOR_PROJECT_ID: scopeIdSchema,
  SANGFOR_REMOTE_BROWSER_URL: endpointSchema,
  SANGFOR_REMOTE_BROWSER_CA_CERT_PATH: absolutePathSchema,
  SANGFOR_REMOTE_BROWSER_CLIENT_CERT_PATH: absolutePathSchema,
  SANGFOR_REMOTE_BROWSER_CLIENT_KEY_PATH: absolutePathSchema,
  SANGFOR_REMOTE_BROWSER_CAPABILITY_PRIVATE_KEY_PATH: absolutePathSchema,
  SANGFOR_REMOTE_BROWSER_CLIENT_IDENTITY_ID: opaqueIdSchema,
  SANGFOR_REMOTE_BROWSER_INSTALLATION_ID: opaqueIdSchema,
  SANGFOR_REMOTE_BROWSER_SERVER_FINGERPRINT_SHA256: fingerprintSchema,
} satisfies Readonly<Record<WiringVariable, z.ZodType<string>>>;

export function collectProductionWiring(environment: CollectorEnvironment): BaselineObservation {
  const parsed = WIRING_VARIABLES.map((name) => {
    const supplied = environment.env[name] !== undefined;
    return { name, supplied, valid: WIRING_SCHEMAS[name].safeParse(environment.env[name]).success };
  });
  const gates = Object.fromEntries(parsed.map(({ name, valid }) => [name, valid]));
  const invalidVariables = parsed.filter((entry) => entry.supplied && !entry.valid).map((entry) => entry.name);
  const missingVariables = parsed.filter((entry) => !entry.supplied).map((entry) => entry.name);
  const draft = {
    sourceId: 'production_wiring',
    origin: `env:${WIRING_VARIABLES.join(',')}`,
    command: 'parse and redact BLRO/JM execution, identity, TLS, endpoint and key-file environment',
    collectedAt: environment.collectedAt,
  } as const;
  const data = { gates, invalidVariables, missingVariables };

  if (invalidVariables.length > 0) {
    return { ...draft, state: 'FAIL', detail: `${invalidVariables.length} wiring variable(s) are malformed`, data };
  }
  if (missingVariables.length > 0) {
    return { ...draft, state: 'BLOCKED', detail: `${missingVariables.length} wiring variable(s) are not configured`, data };
  }
  return { ...draft, state: 'PASS', detail: `${WIRING_VARIABLES.length}/${WIRING_VARIABLES.length} wiring gate(s) are schema-valid`, data };
}
