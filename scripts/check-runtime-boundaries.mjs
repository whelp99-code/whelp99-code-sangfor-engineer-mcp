#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { z } from 'zod';

const TARGETS = ['apps', 'packages', 'scripts'];
const STRICT_PREFIX = 'parseBoundary';
const POLICIES = ['freeze', 'deny', 'loud_failure', 'invalid_report', 'INDETERMINATE'];
const EXPECTED_POLICY_COUNTS = {
  freeze: 20,
  deny: 9,
  loud_failure: 9,
  invalid_report: 6,
  INDETERMINATE: 5,
};

const boundarySchema = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
  file: z.string().min(1),
  legacyLine: z.number().int().positive(),
  owner: z.string().min(1),
  legacySchema: z.string().min(1),
  parser: z.string().regex(/^parseBoundary[A-Za-z0-9]+V1$/u),
  schemaFile: z.string().min(1),
  schemaName: z.string().regex(/^[a-z0-9.-]+\.v1$/u),
  policy: z.enum(POLICIES),
}).strict();

const inventorySchema = z.object({
  version: z.literal(2),
  boundaries: z.array(boundarySchema).length(49),
}).strict();

const astMatchSchema = z.object({
  file: z.string(),
  range: z.object({
    start: z.object({ line: z.number().int().nonnegative() }).passthrough(),
  }).passthrough(),
  metaVariables: z.object({
    single: z.record(z.object({ text: z.string() }).passthrough()),
  }).passthrough(),
}).passthrough();
const astOutputSchema = z.array(astMatchSchema);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const root = argument('--root', process.cwd());
const inventoryPath = argument('--inventory', join(root, 'scripts/runtime-boundaries.inventory.json'));
const jsonOutput = process.argv.includes('--json');

function astMatches(pattern) {
  return runAstGrep(['run', '-p', pattern, '--lang', 'ts', '--json=compact']);
}

function astRuleMatches(rule) {
  return runAstGrep(['scan', '--inline-rules', rule, '--json=compact']);
}

function runAstGrep(argumentsBeforeTargets) {
  const localBinary = join(root, 'node_modules/.bin/ast-grep');
  const binary = existsSync(localBinary) ? localBinary : 'ast-grep';
  const presentTargets = TARGETS.filter((target) => existsSync(join(root, target)));
  if (presentTargets.length === 0) throw new Error('runtime boundary scan has no target directories');
  const result = spawnSync(binary, [...argumentsBeforeTargets, ...presentTargets], { cwd: root, encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  const output = result.stdout.trim();
  if (result.status !== 0 && output !== '[]') {
    throw new Error(`ast-grep failed with status ${String(result.status)}: ${result.stderr.trim()}`);
  }
  return astOutputSchema.parse(JSON.parse(output));
}

function policyCounts(boundaries) {
  const counts = Object.fromEntries(POLICIES.map((policy) => [policy, 0]));
  for (const boundary of boundaries) counts[boundary.policy] += 1;
  return counts;
}

function inspectParserDefinition(boundary, violations) {
  const path = join(root, boundary.schemaFile);
  if (!existsSync(path)) {
    violations.push(`${boundary.id}: schema file is missing`);
    return;
  }
  const source = readFileSync(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = sourceFile.statements.filter((statement) => (
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
  const body = declaration.body.getText(sourceFile);
  if (!body.includes(`schemaName: '${boundary.schemaName}'`)) {
    violations.push(`${boundary.id}: schemaName does not match inventory`);
  }
  if (!body.includes(`policy: '${boundary.policy}'`)) {
    violations.push(`${boundary.id}: policy does not match inventory`);
  }
  if (!body.includes('parseRuntimeJson(') && !body.includes('parseRuntimeJsonLines(')) {
    violations.push(`${boundary.id}: parser bypasses shared runtime protections`);
  }
  if (/\bcatch\b/u.test(body)) {
    violations.push(`${boundary.id}: parser catches or swallows a strict runtime error`);
  }
  if (/return\s+(?:\[\]|\{\})/u.test(body)) {
    violations.push(`${boundary.id}: parser resets rejected input to empty state`);
  }
  if (/\.passthrough\s*\(|z\.unknown\s*\(/u.test(source)) {
    violations.push(`${boundary.id}: schema file contains a permissive passthrough/unknown codec`);
  }
}

const inventory = inventorySchema.parse(JSON.parse(readFileSync(inventoryPath, 'utf8')));
const violations = [];
const duplicateKeys = new Set();
const ids = new Set();
const parsers = new Set();
const ownedCalls = new Map();
let duplicate = 0;

for (const boundary of inventory.boundaries) {
  const callKey = `${boundary.file}:${boundary.parser}`;
  if (ids.has(boundary.id)) duplicateKeys.add(`id:${boundary.id}`);
  if (parsers.has(boundary.parser)) duplicateKeys.add(`parser:${boundary.parser}`);
  if (ownedCalls.has(callKey)) duplicateKeys.add(`call:${callKey}`);
  ids.add(boundary.id);
  parsers.add(boundary.parser);
  ownedCalls.set(callKey, boundary);
}
for (const key of duplicateKeys) {
  duplicate += 1;
  violations.push(`${key}: duplicate inventory ownership`);
}

const strictCallRule = [
  'id: strict-runtime-boundary-call',
  'language: TypeScript',
  'rule:',
  '  pattern: $PARSER($$$ARGS)',
  'constraints:',
  '  PARSER:',
  `    regex: ^${STRICT_PREFIX}[A-Za-z0-9]+V1$`,
  'severity: hint',
].join('\n');
const strictMatches = astRuleMatches(strictCallRule).map((match) => ({
  match,
  parser: match.metaVariables.single['PARSER']?.text ?? '',
}));
const observedCalls = new Map();
let unowned = 0;
for (const { match, parser } of strictMatches) {
  const key = `${match.file}:${parser}`;
  const count = (observedCalls.get(key) ?? 0) + 1;
  observedCalls.set(key, count);
  if (!ownedCalls.has(key)) {
    unowned += 1;
    violations.push(`${match.file}:${match.range.start.line + 1}: unowned strict parser call ${parser}`);
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
  inspectParserDefinition(boundary, violations);
}

const unsafeMatches = astMatches('JSON.parse($SOURCE) as $TYPE');
for (const match of unsafeMatches) {
  violations.push(`${match.file}:${match.range.start.line + 1}: unsafe JSON.parse assertion remains`);
}

const counts = policyCounts(inventory.boundaries);
for (const policy of POLICIES) {
  if (counts[policy] !== EXPECTED_POLICY_COUNTS[policy]) {
    violations.push(`policy ${policy}: expected ${String(EXPECTED_POLICY_COUNTS[policy])}, found ${String(counts[policy])}`);
  }
}

const report = {
  status: violations.length === 0 ? 'pass' : 'fail',
  message: violations.length === 0 ? 'RUNTIME_BOUNDARY_INVENTORY_V2_PASS' : 'RUNTIME_BOUNDARY_INVENTORY_V2_FAIL',
  inventoryVersion: inventory.version,
  strictCalls: strictMatches.length,
  unsafeAssertions: unsafeMatches.length,
  stale,
  duplicate,
  unowned,
  policyCounts: counts,
  ...(violations.length === 0 ? {} : { violations: violations.sort() }),
};

if (jsonOutput) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else if (violations.length === 0) process.stdout.write(`${report.message} (${String(report.strictCalls)} strict boundaries)\n`);
else process.stderr.write(`${violations.sort().join('\n')}\n`);
if (violations.length > 0) process.exitCode = 1;
