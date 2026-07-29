import { createHash } from 'node:crypto';

/**
 * PR-001C: Strict LM/LR method schemas with unknown-key rejection.
 * 
 * LM-01~LM-08: Learning methods for fact observation
 * LR-01~LR-04: Learning research methods for strategy discovery
 */

export type LearningMethodCode =
  | 'LM-01' | 'LM-02' | 'LM-03' | 'LM-04'
  | 'LM-05' | 'LM-06' | 'LM-07' | 'LM-08';

export type LearningResearchCode =
  | 'LR-01' | 'LR-02' | 'LR-03' | 'LR-04';

export type MethodCode = LearningMethodCode | LearningResearchCode;

export interface MethodSchema {
  code: MethodCode;
  version: 1;
  requiredFields: readonly string[];
  optionalFields?: readonly string[];
  forbiddenFields?: readonly string[];
}

export interface MethodRecipe {
  methodCode: MethodCode;
  schemaVersion: 1;
  fields: Record<string, unknown>;
}

export interface MethodResult {
  methodCode: MethodCode;
  status: 'complete' | 'partial' | 'not_observed' | 'not_applicable' | 'blocked' | 'integrity_error' | 'mutation_signal';
  facts?: Record<string, unknown>;
  evidenceDigest?: string;
  conflictCandidates?: ConflictCandidate[];
}

export interface ConflictCandidate {
  methodCode: MethodCode;
  revisionId: string;
  valueDigest: string;
  evidenceFile?: string;
  collectedAt: string;
}

const LM_SCHEMAS: Record<LearningMethodCode, MethodSchema> = {
  'LM-01': {
    code: 'LM-01',
    version: 1,
    requiredFields: ['endpoint', 'method', 'citation'],
    optionalFields: ['keyPaths', 'headers'],
    forbiddenFields: ['shell', 'regex', 'functionName', 'urlHost', 'headerValue'],
  },
  'LM-02': {
    code: 'LM-02',
    version: 1,
    requiredFields: ['recipe', 'endpoint', 'method'],
    optionalFields: ['body', 'headers'],
    forbiddenFields: ['shell', 'regex', 'functionName', 'urlHost', 'headerValue'],
  },
  'LM-03': {
    code: 'LM-03',
    version: 1,
    requiredFields: ['storeId', 'fields'],
    forbiddenFields: ['load', 'sync', 'call', 'shell', 'regex', 'functionName'],
  },
  'LM-04': {
    code: 'LM-04',
    version: 1,
    requiredFields: ['selectors'],
    optionalFields: ['attributes'],
    forbiddenFields: ['click', 'focus', 'scroll', 'value', 'shell', 'regex', 'functionName'],
  },
  'LM-05': {
    code: 'LM-05',
    version: 1,
    requiredFields: ['importRoot', 'filePattern'],
    optionalFields: ['maxFileSize', 'maxRows', 'maxFields', 'maxStringLength', 'parseTimeout'],
    forbiddenFields: ['symlink', 'pathTraversal', 'shell', 'regex', 'functionName'],
  },
  'LM-06': {
    code: 'LM-06',
    version: 1,
    requiredFields: ['frameListener'],
    forbiddenFields: ['send', 'newWebSocket', 'newEventSource', 'shell', 'regex', 'functionName'],
  },
  'LM-07': {
    code: 'LM-07',
    version: 1,
    requiredFields: ['roi', 'typeParser'],
    forbiddenFields: ['pixelStorage', 'rawOcrText', 'autoPass', 'shell', 'regex', 'functionName'],
  },
  'LM-08': {
    code: 'LM-08',
    version: 1,
    requiredFields: ['observationDigest', 'reviewer', 'identity', 'nonce', 'expiry'],
    forbiddenFields: ['forgedBoolean', 'freeFormSecret', 'shell', 'regex', 'functionName'],
  },
};

const LR_SCHEMAS: Record<LearningResearchCode, MethodSchema> = {
  'LR-01': {
    code: 'LR-01',
    version: 1,
    requiredFields: ['citation', 'pageVerified'],
    optionalFields: ['productApplicability', 'versionApplicability'],
    forbiddenFields: ['shell', 'regex', 'functionName'],
  },
  'LR-02': {
    code: 'LR-02',
    version: 1,
    requiredFields: ['captureStructure', 'allowlist'],
    forbiddenFields: ['rawSecret', 'rawPayload', 'shell', 'regex', 'functionName'],
  },
  'LR-03': {
    code: 'LR-03',
    version: 1,
    requiredFields: ['frameworkProbe', 'routeProbe', 'capabilityProbe'],
    forbiddenFields: ['frameworkAssumption', 'shell', 'regex', 'functionName'],
  },
  'LR-04': {
    code: 'LR-04',
    version: 1,
    requiredFields: ['benchmark', 'baseline'],
    forbiddenFields: ['shell', 'regex', 'functionName'],
  },
};

export function getMethodSchema(code: MethodCode): MethodSchema {
  if (code.startsWith('LM-')) {
    return LM_SCHEMAS[code as LearningMethodCode];
  }
  return LR_SCHEMAS[code as LearningResearchCode];
}

export function validateMethodRecipe(recipe: MethodRecipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const schema = getMethodSchema(recipe.methodCode);

  if (!schema) {
    return { valid: false, errors: [`Unknown method code: ${recipe.methodCode}`] };
  }

  if (recipe.schemaVersion !== 1) {
    errors.push(`Invalid schema version: ${recipe.schemaVersion}, expected 1`);
  }

  // Check required fields
  for (const field of schema.requiredFields) {
    if (!(field in recipe.fields)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Check forbidden fields (unknown-key rejection)
  const forbidden = schema.forbiddenFields ?? [];
  for (const field of forbidden) {
    if (field in recipe.fields) {
      errors.push(`Forbidden field present: ${field}`);
    }
  }

  // Check for unknown keys (strict schema)
  const allowedFields = new Set([
    ...schema.requiredFields,
    ...(schema.optionalFields ?? []),
  ]);
  for (const key of Object.keys(recipe.fields)) {
    if (!allowedFields.has(key)) {
      errors.push(`Unknown field: ${key}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function computeValueDigest(value: unknown): string {
  const canonical = JSON.stringify(value, Object.keys(value as object).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

export function isCompleteResult(result: MethodResult): boolean {
  return result.status === 'complete';
}

export function isTerminalResult(result: MethodResult): boolean {
  return ['complete', 'partial', 'blocked', 'integrity_error', 'mutation_signal'].includes(result.status);
}

export function shouldAbortRun(result: MethodResult): boolean {
  return ['blocked', 'integrity_error', 'mutation_signal'].includes(result.status);
}
