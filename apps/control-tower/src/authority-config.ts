import { z } from 'zod';

const authorityIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  .refine((value) => !value.includes('..'));
const secretSchema = z.string().min(32).max(4096);
const absolutePathSchema = z.string().min(1).max(4096).startsWith('/');

function isPostgresDatabaseUrl(value: string): boolean {
  try {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (url.protocol === 'postgresql:' || url.protocol === 'postgres:')
      && Boolean(url.hostname && url.pathname.slice(1) && url.username && url.password);
  } catch {
    return false;
  }
}

const authorityConfigSchema = z.object({
  authorityStore: z.literal('postgres'),
  databaseUrl: z.string().min(1).max(4096).refine(isPostgresDatabaseUrl),
  tenantId: authorityIdSchema,
  projectId: authorityIdSchema,
  signingPrivateKeyPath: absolutePathSchema,
  trustBundlePath: absolutePathSchema,
  auditSecret: secretSchema,
  approvalSecret: secretSchema,
}).strict().readonly();

export type AuthorityConfig = z.infer<typeof authorityConfigSchema>;
export type AuthorityConfigField =
  | 'SANGFOR_BLRO_AUTHORITY_STORE'
  | 'DATABASE_URL'
  | 'SANGFOR_TENANT_ID'
  | 'SANGFOR_PROJECT_ID'
  | 'SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH'
  | 'SANGFOR_BLRO_TRUST_BUNDLE_PATH'
  | 'SANGFOR_BLRO_AUDIT_SECRET'
  | 'SANGFOR_OPERATOR_APPROVAL_SECRET';
export type AuthorityConfigIssue = {
  readonly code: 'CONFIG_FIELD_INVALID';
  readonly field: AuthorityConfigField;
};
export type AuthorityConfigResult =
  | { readonly success: true; readonly data: AuthorityConfig }
  | { readonly success: false; readonly issues: readonly AuthorityConfigIssue[] };

export type AuthorityRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const CONFIG_FIELDS = {
  authorityStore: 'SANGFOR_BLRO_AUTHORITY_STORE',
  databaseUrl: 'DATABASE_URL',
  tenantId: 'SANGFOR_TENANT_ID',
  projectId: 'SANGFOR_PROJECT_ID',
  signingPrivateKeyPath: 'SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH',
  trustBundlePath: 'SANGFOR_BLRO_TRUST_BUNDLE_PATH',
  auditSecret: 'SANGFOR_BLRO_AUDIT_SECRET',
  approvalSecret: 'SANGFOR_OPERATOR_APPROVAL_SECRET',
} as const satisfies Readonly<Record<keyof AuthorityConfig, AuthorityConfigField>>;

function isAuthorityConfigKey(value: string): value is keyof AuthorityConfig {
  return Object.hasOwn(CONFIG_FIELDS, value);
}

export function parseAuthorityConfig(environment: AuthorityRuntimeEnvironment): AuthorityConfigResult {
  const parsed = authorityConfigSchema.safeParse({
    authorityStore: environment.SANGFOR_BLRO_AUTHORITY_STORE,
    databaseUrl: environment.DATABASE_URL,
    tenantId: environment.SANGFOR_TENANT_ID,
    projectId: environment.SANGFOR_PROJECT_ID,
    signingPrivateKeyPath: environment.SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH,
    trustBundlePath: environment.SANGFOR_BLRO_TRUST_BUNDLE_PATH,
    auditSecret: environment.SANGFOR_BLRO_AUDIT_SECRET,
    approvalSecret: environment.SANGFOR_OPERATOR_APPROVAL_SECRET,
  });
  if (parsed.success) return parsed;
  const fields = new Set<AuthorityConfigField>();
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && isAuthorityConfigKey(key)) {
      fields.add(CONFIG_FIELDS[key]);
    }
  }
  return {
    success: false,
    issues: [...fields].map((field) => ({ code: 'CONFIG_FIELD_INVALID', field })),
  };
}
