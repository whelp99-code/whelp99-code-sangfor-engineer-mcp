import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  parseAuthorityConfig,
  type AuthorityRuntimeEnvironment,
} from '../apps/control-tower/src/authority-config.js';

const completeEnvironment = (databaseUrl: string): AuthorityRuntimeEnvironment => ({
  SANGFOR_BLRO_AUTHORITY_STORE: 'postgres',
  DATABASE_URL: databaseUrl,
  SANGFOR_TENANT_ID: 'tenant-a',
  SANGFOR_PROJECT_ID: 'project-a',
  SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH: '/run/secrets/signing.key',
  SANGFOR_BLRO_TRUST_BUNDLE_PATH: '/run/secrets/ca.crt',
  SANGFOR_BLRO_AUDIT_SECRET: 'a'.repeat(32),
  SANGFOR_OPERATOR_APPROVAL_SECRET: 'o'.repeat(32),
});

const configFailureSchema = z.object({
  success: z.literal(false),
  issues: z.array(z.object({
    code: z.literal('CONFIG_FIELD_INVALID'),
    field: z.string(),
  }).strict()),
}).strict();

const malformedUrls = [
  '',
  'not-a-url',
  'http://authority.example/blro',
  'postgresql://%',
  'postgresql://user:secret@/blro',
] as const;

describe('BLRO authority config parsing', () => {
  it.each(malformedUrls)('returns masked typed issues without throwing for DATABASE_URL=%j', (databaseUrl) => {
    const environment = completeEnvironment(databaseUrl);

    const action = (): ReturnType<typeof parseAuthorityConfig> => parseAuthorityConfig(environment);

    expect(action).not.toThrow();
    const result = action();
    expect(result).toMatchObject({
      success: false,
      issues: [{ code: 'CONFIG_FIELD_INVALID', field: 'DATABASE_URL' }],
    });
    expect(JSON.stringify(result)).not.toContain(databaseUrl || 'secret');
  });

  it('returns field names without rejected values when every field is invalid', () => {
    const rejected = {
      SANGFOR_BLRO_AUTHORITY_STORE: 'postgres',
      DATABASE_URL: 'postgresql://user:do-not-echo@%',
      SANGFOR_TENANT_ID: '../tenant-secret',
      SANGFOR_PROJECT_ID: '',
      SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH: 'relative-secret-key',
      SANGFOR_BLRO_TRUST_BUNDLE_PATH: '',
      SANGFOR_BLRO_AUDIT_SECRET: 'short-audit-secret',
      SANGFOR_OPERATOR_APPROVAL_SECRET: 'short-approval-secret',
    } satisfies AuthorityRuntimeEnvironment;

    const result = parseAuthorityConfig(rejected);

    const failure = configFailureSchema.parse(result);
    expect(failure.issues.map((issue) => issue.field)).toEqual([
      'DATABASE_URL', 'SANGFOR_TENANT_ID', 'SANGFOR_PROJECT_ID',
      'SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH', 'SANGFOR_BLRO_TRUST_BUNDLE_PATH',
      'SANGFOR_BLRO_AUDIT_SECRET', 'SANGFOR_OPERATOR_APPROVAL_SECRET',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/do-not-echo|tenant-secret|relative-secret|short-/u);
  });
});
