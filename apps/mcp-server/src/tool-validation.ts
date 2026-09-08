import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type {
  ToolArgumentIssue,
  ToolArgumentValidation,
  ToolCatalogEntry,
  ToolDefinition,
  ToolRuntime,
} from './mcp-contracts.js';

export class ToolSchemaCompilationError extends Error {
  readonly name = 'ToolSchemaCompilationError';

  constructor(readonly toolName: string, options?: ErrorOptions) {
    super(`INVALID_TOOL_SCHEMA: ${toolName}`, options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedSchemaValue);
  if (!isRecord(value)) return value;
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizedSchemaValue(child)]),
  );
  const declaresMapSemantics = !Object.hasOwn(value, 'properties')
    || Object.hasOwn(value, 'additionalProperties')
    || Object.hasOwn(value, 'patternProperties');
  return value['type'] === 'object' && !declaresMapSemantics
    ? { ...normalized, additionalProperties: false }
    : normalized;
}

function closedObjectSchema(value: object): object {
  const normalized = normalizedSchemaValue(value);
  if (!isRecord(normalized)) throw new TypeError('JSON_SCHEMA_OBJECT_REQUIRED');
  return normalized;
}

function issueFrom(error: ErrorObject): ToolArgumentIssue {
  return {
    code: error.keyword,
    path: error.instancePath,
    schemaPath: error.schemaPath,
  };
}

function sortedIssues(errors: readonly ErrorObject[] | null | undefined): readonly ToolArgumentIssue[] {
  const unique = new Map<string, ToolArgumentIssue>();
  for (const issue of (errors ?? []).map(issueFrom)) {
    unique.set(`${issue.path}\0${issue.code}\0${issue.schemaPath}`, issue);
  }
  return [...unique.values()].sort((left, right) =>
    left.path.localeCompare(right.path)
      || left.code.localeCompare(right.code)
      || left.schemaPath.localeCompare(right.schemaPath));
}

export function createToolRuntime(entries: readonly ToolCatalogEntry[]): ToolRuntime {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const definitions = new Map<string, ToolDefinition>();
  const validators = new Map<string, ValidateFunction>();
  for (const [name, definition] of entries) {
    if (definitions.has(name)) throw new ToolSchemaCompilationError(name);
    let validator: ValidateFunction;
    try {
      validator = ajv.compile(closedObjectSchema(definition.inputSchema));
    } catch (error) {
      throw new ToolSchemaCompilationError(name, { cause: error });
    }
    definitions.set(name, definition);
    validators.set(name, validator);
  }
  return {
    entries,
    validatorCount: validators.size,
    definition: (name) => definitions.get(name),
    validate: (name, args): ToolArgumentValidation => {
      if (args === undefined) {
        return { ok: false, issues: [{ code: 'arguments_required', path: '', schemaPath: '#' }] };
      }
      const validator = validators.get(name);
      if (validator === undefined) {
        return { ok: false, issues: [{ code: 'tool_schema_missing', path: '', schemaPath: '#' }] };
      }
      return validator(args) ? { ok: true } : { ok: false, issues: sortedIssues(validator.errors) };
    },
  };
}
