import {
  JM_AGENT_CONFIG_FIELDS,
  JM_AGENT_CONFIG_KEYS,
  JM_AGENT_ENVIRONMENT_NAMES,
  JM_AGENT_FORBIDDEN_FIELDS,
  isJmAgentConfigKey,
  jmAgentConfigSchema,
  type JmAgentConfig,
  type JmAgentConfigField,
  type JmAgentEnvironment,
} from './config-schema.js';
import { checkMaterialPath, type MaterialRefusal } from './material.js';
import { checkServerIdentity, type ServerIdentityRefusal } from './server-identity.js';

export type JmAgentConfigIssueCode =
  | 'CONFIG_FIELD_INVALID'
  | 'CONFIG_FIELD_UNKNOWN'
  | 'CONFIG_FIELD_FORBIDDEN'
  | MaterialRefusal
  | ServerIdentityRefusal;

export type JmAgentConfigIssue = {
  readonly code: JmAgentConfigIssueCode;
  readonly field: JmAgentConfigField | string;
};

export type JmAgentConfigResult =
  | { readonly success: true; readonly data: JmAgentConfig }
  | { readonly success: false; readonly issues: readonly JmAgentConfigIssue[] };

type PathField = Extract<
  keyof JmAgentConfig,
  'tlsCertPath' | 'tlsKeyPath' | 'tlsClientCaPath'
  | 'verifyKeyRingPath' | 'grantSnapshotPath'
>;

const PRIVATE_KEY_FIELDS: ReadonlySet<PathField> = new Set<PathField>(['tlsKeyPath']);
const PATH_FIELDS: readonly PathField[] = [
  'tlsCertPath', 'tlsKeyPath', 'tlsClientCaPath', 'verifyKeyRingPath', 'grantSnapshotPath',
];

export function parseJmAgentConfig(
  environment: JmAgentEnvironment,
  now: Date = new Date(),
): JmAgentConfigResult {
  const rejected = [...forbiddenFields(environment), ...unknownFields(environment)];
  const parsed = jmAgentConfigSchema.safeParse(shapeEnvironment(environment));
  if (!parsed.success) {
    return { success: false, issues: [...rejected, ...schemaIssues(parsed.error.issues)] };
  }
  const material = materialIssues(parsed.data, now);
  if (rejected.length > 0 || material.length > 0) {
    return { success: false, issues: [...rejected, ...material] };
  }
  return { success: true, data: parsed.data };
}

function shapeEnvironment(environment: JmAgentEnvironment): Record<string, string | undefined> {
  return Object.fromEntries(JM_AGENT_CONFIG_KEYS.map((key) => (
    [key, environment[JM_AGENT_CONFIG_FIELDS[key]]]
  )));
}

function forbiddenFields(environment: JmAgentEnvironment): readonly JmAgentConfigIssue[] {
  return JM_AGENT_FORBIDDEN_FIELDS
    .filter((name) => Object.hasOwn(environment, name))
    .map((field) => ({ code: 'CONFIG_FIELD_FORBIDDEN' as const, field }));
}

function unknownFields(environment: JmAgentEnvironment): readonly JmAgentConfigIssue[] {
  const known = new Set(JM_AGENT_ENVIRONMENT_NAMES);
  const forbidden = new Set(JM_AGENT_FORBIDDEN_FIELDS);
  return Object.keys(environment)
    .filter((name) => name.startsWith('SANGFOR_JM_AGENT_')
      && !known.has(name) && !forbidden.has(name))
    .map((field) => ({ code: 'CONFIG_FIELD_UNKNOWN' as const, field }));
}

function schemaIssues(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): readonly JmAgentConfigIssue[] {
  const fields = new Set<JmAgentConfigField>();
  for (const issue of issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && isJmAgentConfigKey(key)) fields.add(JM_AGENT_CONFIG_FIELDS[key]);
  }
  return [...fields].map((field) => ({ code: 'CONFIG_FIELD_INVALID' as const, field }));
}

function materialIssues(
  config: JmAgentConfig,
  now: Date,
): readonly JmAgentConfigIssue[] {
  const issues: JmAgentConfigIssue[] = [];
  for (const key of PATH_FIELDS) {
    const check = checkMaterialPath(config[key], PRIVATE_KEY_FIELDS.has(key));
    if (!check.ok) issues.push({ code: check.reason, field: JM_AGENT_CONFIG_FIELDS[key] });
  }
  if (issues.length > 0) return issues;
  const identity = checkServerIdentity({
    certPath: config.tlsCertPath,
    keyPath: config.tlsKeyPath,
    caPath: config.tlsClientCaPath,
    now,
  });
  if (!identity.ok) {
    issues.push({ code: identity.reason, field: JM_AGENT_CONFIG_FIELDS.tlsCertPath });
  }
  return issues;
}
