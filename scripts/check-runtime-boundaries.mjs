#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import ts from 'typescript';
import { z } from 'zod';
import {
  scanRuntimeBoundarySources,
  STRICT_RUNTIME_PARSER,
} from './lib/runtime-boundary-source-scan.mjs';

const POLICIES = ['freeze', 'deny', 'loud_failure', 'invalid_report', 'INDETERMINATE'];
const EXPECTED_BOUNDARY_COUNT = 49;
const EXPECTED_ENVIRONMENT_BOUNDARY_COUNT = 2;
const EXPECTED_POLICY_COUNTS = {
  freeze: 20,
  deny: 9,
  loud_failure: 9,
  invalid_report: 6,
  INDETERMINATE: 5,
};
const EXPECTED_ENVIRONMENT_POLICY_COUNTS = {
  freeze: 0,
  deny: 2,
  loud_failure: 0,
  invalid_report: 0,
  INDETERMINATE: 0,
};

const boundaryFields = {
  id: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
  file: z.string().min(1),
  legacyLine: z.number().int().positive(),
  owner: z.string().min(1),
  legacySchema: z.string().min(1),
  parser: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u),
  schemaFile: z.string().min(1),
  schemaName: z.string().regex(/^[a-z0-9.-]+\.v1$/u),
  policy: z.enum(POLICIES),
};
const boundarySchema = z.object(boundaryFields).strict().superRefine((boundary, context) => {
  if (!STRICT_RUNTIME_PARSER.test(boundary.parser)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'strict parser must follow the runtime boundary parser convention',
      path: ['parser'],
    });
  }
});
const environmentBoundarySchema = z.object({
  ...boundaryFields,
  environmentVariable: z.string().regex(/^[A-Z][A-Z0-9_]*_JSON$/u),
}).strict();

const inventorySchema = z.object({
  version: z.literal(2),
  boundaries: z.array(boundarySchema),
  environmentBoundaries: z.array(environmentBoundarySchema),
}).strict();

function policyCounts(boundaries) {
  const counts = Object.fromEntries(POLICIES.map((policy) => [policy, 0]));
  for (const boundary of boundaries) counts[boundary.policy] += 1;
  return counts;
}

function inspectParserDefinition(root, boundary, violations) {
  const path = join(root, boundary.schemaFile);
  if (!existsSync(path)) {
    violations.push(`${boundary.id}: schema file is missing`);
    return;
  }
  const sourceText = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = source.statements.filter((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === boundary.parser
  ));
  if (declarations.length !== 1) {
    violations.push(`${boundary.id}: expected one exported parser definition, found ${String(declarations.length)}`);
    return;
  }
  const declaration = declarations[0];
  const exported = declaration.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true;
  if (!exported || declaration.body === undefined) {
    violations.push(`${boundary.id}: parser definition must be an exported function with a body`);
    return;
  }
  const body = declaration.body.getText(source);
  if (!body.includes(`schemaName: '${boundary.schemaName}'`)) violations.push(`${boundary.id}: schemaName does not match inventory`);
  if (!body.includes(`policy: '${boundary.policy}'`)) violations.push(`${boundary.id}: policy does not match inventory`);
  if (!body.includes('parseRuntimeJson(') && !body.includes('parseRuntimeJsonLines(')) {
    violations.push(`${boundary.id}: parser bypasses shared runtime protections`);
  }
  if (/\bcatch\b/u.test(body)) violations.push(`${boundary.id}: parser catches or swallows a strict runtime error`);
  if (/return\s+(?:\[\]|\{\})/u.test(body)) violations.push(`${boundary.id}: parser resets rejected input to empty state`);
  if (/\.passthrough\s*\(|z\.unknown\s*\(/u.test(sourceText)) {
    violations.push(`${boundary.id}: schema file contains a permissive passthrough/unknown codec`);
  }
}

export function checkRuntimeBoundaries(options) {
  const root = options.root;
  const inventoryPath = options.inventoryPath ?? join(root, 'scripts/runtime-boundaries.inventory.json');
  const inventory = inventorySchema.parse(JSON.parse(readFileSync(inventoryPath, 'utf8')));
  const violations = [];
  const duplicateKeys = new Set();
  const ids = new Set();
  const parsers = new Set();
  const ownedCalls = new Map();
  const ownedEnvironmentJson = new Map();
  let duplicate = 0;

  const allBoundaries = [...inventory.boundaries, ...inventory.environmentBoundaries];
  for (const boundary of allBoundaries) {
    const callKey = `${boundary.file}:${boundary.parser}`;
    if (ids.has(boundary.id)) duplicateKeys.add(`id:${boundary.id}`);
    if (parsers.has(boundary.parser)) duplicateKeys.add(`parser:${boundary.parser}`);
    if (ownedCalls.has(callKey)) duplicateKeys.add(`call:${callKey}`);
    if ('environmentVariable' in boundary) {
      const environmentKey = `${boundary.file}:${boundary.environmentVariable}`;
      if (ownedEnvironmentJson.has(environmentKey)) duplicateKeys.add(`environment:${environmentKey}`);
      ownedEnvironmentJson.set(environmentKey, boundary);
    }
    ids.add(boundary.id);
    parsers.add(boundary.parser);
    ownedCalls.set(callKey, boundary);
  }
  for (const key of duplicateKeys) {
    duplicate += 1;
    violations.push(`${key}: duplicate inventory ownership`);
  }

  const scan = scanRuntimeBoundarySources(root, parsers);
  const observedCalls = new Map();
  let unowned = 0;
  for (const match of scan.parserCalls) {
    const key = `${match.file}:${match.parser}`;
    observedCalls.set(key, (observedCalls.get(key) ?? 0) + 1);
    if (!ownedCalls.has(key)) {
      unowned += 1;
      violations.push(`${match.file}:${String(match.line)}: unowned strict parser call ${match.parser}`);
    }
  }

  const observedEnvironmentJson = new Map();
  for (const match of scan.environmentJson) {
    const key = `${match.file}:${match.variable}`;
    observedEnvironmentJson.set(key, (observedEnvironmentJson.get(key) ?? 0) + 1);
    if (!ownedEnvironmentJson.has(key)) {
      unowned += 1;
      violations.push(`${match.file}:${String(match.line)}: unowned critical environment JSON ${match.variable}`);
    }
  }

  let stale = 0;
  for (const [key, boundary] of ownedCalls) {
    const count = observedCalls.get(key) ?? 0;
    if (count === 0) {
      stale += 1;
      violations.push(`${boundary.id}: stale inventory entry has no ${boundary.parser} call in ${boundary.file}`);
    } else if (count > 1) {
      duplicate += count - 1;
      violations.push(`${boundary.id}: strict parser call occurs ${String(count)} times in ${boundary.file}`);
    }
    inspectParserDefinition(root, boundary, violations);
  }
  for (const [key, boundary] of ownedEnvironmentJson) {
    const count = observedEnvironmentJson.get(key) ?? 0;
    if (count === 0) {
      stale += 1;
      violations.push(`${boundary.id}: stale environment inventory entry has no ${boundary.environmentVariable} read in ${boundary.file}`);
    } else if (count > 1) {
      duplicate += count - 1;
      violations.push(`${boundary.id}: critical environment JSON is read ${String(count)} times in ${boundary.file}`);
    }
  }

  for (const match of scan.unsafeAssertions) {
    violations.push(`${match.file}:${String(match.line)}: unsafe JSON.parse assertion remains`);
  }
  if (inventory.boundaries.length !== EXPECTED_BOUNDARY_COUNT) {
    violations.push(`strict boundary inventory: expected ${String(EXPECTED_BOUNDARY_COUNT)}, found ${String(inventory.boundaries.length)}`);
  }
  if (inventory.environmentBoundaries.length !== EXPECTED_ENVIRONMENT_BOUNDARY_COUNT) {
    violations.push(`environment boundary inventory: expected ${String(EXPECTED_ENVIRONMENT_BOUNDARY_COUNT)}, found ${String(inventory.environmentBoundaries.length)}`);
  }
  const counts = policyCounts(inventory.boundaries);
  const environmentCounts = policyCounts(inventory.environmentBoundaries);
  for (const policy of POLICIES) {
    if (counts[policy] !== EXPECTED_POLICY_COUNTS[policy]) {
      violations.push(`policy ${policy}: expected ${String(EXPECTED_POLICY_COUNTS[policy])}, found ${String(counts[policy])}`);
    }
    if (environmentCounts[policy] !== EXPECTED_ENVIRONMENT_POLICY_COUNTS[policy]) {
      violations.push(`environment policy ${policy}: expected ${String(EXPECTED_ENVIRONMENT_POLICY_COUNTS[policy])}, found ${String(environmentCounts[policy])}`);
    }
  }

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    message: violations.length === 0 ? 'RUNTIME_BOUNDARY_INVENTORY_V2_PASS' : 'RUNTIME_BOUNDARY_INVENTORY_V2_FAIL',
    inventoryVersion: inventory.version,
    strictCalls: scan.strictCalls.length,
    unsafeAssertions: scan.unsafeAssertions.length,
    environmentJson: scan.environmentJson.length,
    stale,
    duplicate,
    unowned,
    policyCounts: counts,
    environmentPolicyCounts: environmentCounts,
    ...(violations.length === 0 ? {} : { violations: violations.sort() }),
  };
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function main() {
  const root = argument('--root', process.cwd());
  const report = checkRuntimeBoundaries({
    root,
    inventoryPath: argument('--inventory', join(root, 'scripts/runtime-boundaries.inventory.json')),
  });
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (report.status === 'pass') process.stdout.write(`${report.message} (${String(report.strictCalls)} strict boundaries)\n`);
  else process.stderr.write(`${report.violations.join('\n')}\n`);
  if (report.status === 'fail') process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
