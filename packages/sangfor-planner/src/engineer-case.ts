import { RuntimeSchemaError } from '../../shared/src/runtime-schema.js';
import {
  ENGINEER_ID_RE,
  engineerCaseDocumentSchema,
  isEngineerCaseAuthContext,
  parseEngineerCaseDocument,
  type EngineerCase,
  type EngineerCaseAuthContext,
  type EngineerCaseDocument,
  type EngineerValue,
} from '../../shared/src/engineer-case-contract.js';

export type EngineerCaseIssue = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
};

export type EngineerCaseAssembly =
  | { readonly ok: true; readonly value: EngineerCase; readonly guideReadyGranted: false }
  | { readonly ok: false; readonly issues: readonly EngineerCaseIssue[] };

export class EngineerCaseValidationError extends Error {
  override readonly name = 'EngineerCaseValidationError';
  constructor(readonly issues: readonly EngineerCaseIssue[]) {
    super(`ENGINEER_CASE_INVALID: ${issues.map((issue) => issue.code).join(',')}`);
  }
}

function issue(code: string, path: string, message = code): EngineerCaseIssue {
  return { code, path, message };
}

function validateAuth(auth: unknown): EngineerCaseIssue[] {
  if (auth == null) return [issue('AUTH_CONTEXT_REQUIRED', 'auth')];
  if (!isEngineerCaseAuthContext(auth)) return [issue('AUTH_CONTEXT_INVALID', 'auth')];
  return [];
}

function assertFiniteNumbers(value: unknown, path = '$'): EngineerCaseIssue[] {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return [issue('INVALID_NUMBER', path, 'NaN and Infinity are refused')];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => assertFiniteNumbers(item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => assertFiniteNumbers(child, `${path}.${key}`));
  }
  return [];
}

function mapZodMessage(message: string): string {
  if (message.startsWith('FIXTURE_MARKED_OBSERVED')) return 'FIXTURE_MARKED_OBSERVED';
  if (message.startsWith('MISSING_ORIGINAL_MARKED_OBSERVED')) return 'MISSING_ORIGINAL_MARKED_OBSERVED';
  if (message.startsWith('SYNTHETIC_MARKED_LIVE')) return 'SYNTHETIC_MARKED_LIVE';
  if (message.startsWith('UNKNOWN_COERCED')) return 'UNKNOWN_COERCED';
  if (message.startsWith('UNKNOWN_ID_REF')) return 'UNKNOWN_ID_REF';
  if (message.startsWith('CROSS_PROJECT_REF')) return 'CROSS_PROJECT_REF';
  if (message.startsWith('CROSS_CASE_REF')) return 'CROSS_CASE_REF';
  if (message.startsWith('DUPLICATE_ID')) return 'DUPLICATE_ID';
  if (message.startsWith('DERIVED_FORMULA_MISSING')) return 'DERIVED_FORMULA_MISSING';
  if (message.startsWith('INVALID_ID')) return 'INVALID_ID';
  if (message.includes('Unrecognized key')) return 'UNKNOWN_FIELD';
  if (message.includes('datetime') || message.includes('ISO')) return 'INVALID_DATE';
  if (message.includes('Invalid enum value') && message.includes('unit')) return 'INVALID_UNIT';
  if (message.includes('Invalid enum value')) return 'INVALID_ENUM';
  if (message.includes('Invalid input')) return 'SCHEMA_MISMATCH';
  return message;
}

function issuesFromDocument(input: unknown): EngineerCaseIssue[] {
  const parsed = engineerCaseDocumentSchema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((item) => {
    const path = item.path.join('.') || '$';
    let code = mapZodMessage(item.message);
    if ((code === 'INVALID_ENUM' || item.code === 'invalid_enum_value') && path.endsWith('unit')) {
      code = 'INVALID_UNIT';
    }
    return issue(code, path, item.message);
  });
}

function issuesFromRuntime(error: RuntimeSchemaError, input: unknown): EngineerCaseIssue[] {
  const first = error.issues[0];
  if (first?.code === 'unknown_version') {
    return [issue('UNSUPPORTED_SCHEMA_VERSION', (first.path ?? ['schemaVersion']).join('.'))];
  }
  if (first?.code === 'duplicate_id') {
    return [issue('DUPLICATE_ID', (first.path ?? ['id']).join('.'))];
  }
  if (first?.code === 'malformed_json') {
    return [issue('MALFORMED_JSON', '$')];
  }
  const detailed = issuesFromDocument(input);
  if (detailed.length > 0) return detailed;
  return error.issues.map((item) => issue(
    item.code === 'schema_mismatch' ? 'SCHEMA_MISMATCH' : item.code.toUpperCase(),
    item.path.join('.') || '$',
  ));
}

function claimedScopeIssues(document: EngineerCaseDocument, auth: EngineerCaseAuthContext): EngineerCaseIssue[] {
  const issues: EngineerCaseIssue[] = [];
  if (document.tenantId && document.tenantId !== auth.tenantId) {
    issues.push(issue('UNTRUSTED_SCOPE_CLAIM', 'tenantId'));
  }
  if (document.projectId && document.projectId !== auth.projectId) {
    issues.push(issue('UNTRUSTED_SCOPE_CLAIM', 'projectId'));
  }
  if (document.actorId && document.actorId !== auth.actorId) {
    issues.push(issue('UNTRUSTED_SCOPE_CLAIM', 'actorId'));
  }
  const collections = [
    ...document.observations.map((item, index) => ({ item, path: `observations.${index}` })),
    ...document.requirements.map((item, index) => ({ item, path: `requirements.${index}` })),
    ...document.calculations.map((item, index) => ({ item, path: `calculations.${index}` })),
    ...document.assessments.map((item, index) => ({ item, path: `assessments.${index}` })),
  ];
  for (const { item, path } of collections) {
    if (item.projectId && item.projectId !== auth.projectId) {
      issues.push(issue('CROSS_PROJECT_REF', `${path}.projectId`));
    }
  }
  document.evidence.forEach((item, index) => {
    if (item.owner && item.owner.projectId !== auth.projectId) {
      issues.push(issue('CROSS_PROJECT_REF', `evidence.${index}.owner.projectId`));
    }
    if (item.owner && item.owner.tenantId !== auth.tenantId) {
      issues.push(issue('CROSS_PROJECT_REF', `evidence.${index}.owner.tenantId`));
    }
  });
  return issues;
}

function hasUnknownValue(value: EngineerValue | undefined): boolean {
  return value?.presence === 'unknown';
}

function assembleReadiness(document: EngineerCaseDocument): 'draft' | 'blocked' {
  const unknownPresent = document.observations.some((item) => item.sourceKind === 'unknown' || hasUnknownValue(item.value))
    || document.calculations.some((item) => item.sourceKind === 'unknown' || hasUnknownValue(item.result))
    || document.guide.unresolved.length > 0
    || document.assessments.some((item) => item.status === 'unresolved');
  return unknownPresent ? 'blocked' : 'draft';
}

/**
 * Validate a versioned engineer-case document and stamp tenant/project/actor
 * from the authenticated execution context. Contract success never grants
 * guide review_ready.
 */
export function assembleEngineerCase(input: unknown, auth: unknown): EngineerCaseAssembly {
  const authIssues = validateAuth(auth);
  if (authIssues.length > 0) return { ok: false, issues: authIssues };
  const context = auth as EngineerCaseAuthContext;

  const finiteIssues = typeof input === 'string' ? [] : assertFiniteNumbers(input);
  if (finiteIssues.length > 0) return { ok: false, issues: finiteIssues };

  let source: string;
  let raw: unknown = input;
  if (typeof input === 'string') {
    source = input;
  } else {
    try {
      source = JSON.stringify(input);
    } catch {
      return { ok: false, issues: [issue('MALFORMED_JSON', '$')] };
    }
  }

  let document: EngineerCaseDocument;
  try {
    document = parseEngineerCaseDocument(source);
  } catch (error) {
    if (error instanceof RuntimeSchemaError) {
      if (typeof input === 'string') {
        try { raw = JSON.parse(input); } catch { raw = undefined; }
      }
      return { ok: false, issues: issuesFromRuntime(error, raw) };
    }
    throw error;
  }

  const scopeIssues = claimedScopeIssues(document, context);
  if (scopeIssues.length > 0) return { ok: false, issues: scopeIssues };

  const value: EngineerCase = {
    ...document,
    tenantId: context.tenantId,
    projectId: context.projectId,
    actorId: context.actorId,
    guide: {
      ...document.guide,
      readiness: assembleReadiness(document),
    },
    evidence: document.evidence.map((item) => ({
      ...item,
      owner: item.owner ?? {
        tenantId: context.tenantId,
        projectId: context.projectId,
        caseId: document.caseId,
      },
    })),
  };

  return { ok: true, value, guideReadyGranted: false };
}

export function validateEngineerCase(input: unknown, auth: unknown): EngineerCaseAssembly {
  return assembleEngineerCase(input, auth);
}

export function isEngineerId(value: string): boolean {
  return ENGINEER_ID_RE.test(value) && value !== '.' && value !== '..' && !value.includes('..');
}
