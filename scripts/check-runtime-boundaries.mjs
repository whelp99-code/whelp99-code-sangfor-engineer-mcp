#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';

const root = process.cwd();
const inventoryPath = join(root, 'scripts/runtime-boundaries.inventory.json');
const pattern = 'JSON.parse($SOURCE) as $TYPE';
const targets = ['apps', 'packages', 'scripts'];
const policies = z.enum(['deny', 'invalid_report', 'INDETERMINATE', 'freeze', 'loud_failure']);

const boundarySchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  owner: z.string().min(1),
  schema: z.string().min(1),
  policy: policies,
}).strict();

const inventorySchema = z.object({
  version: z.literal(1),
  boundaries: z.array(boundarySchema),
}).strict();

const astMatchSchema = z.object({
  file: z.string(),
  range: z.object({
    start: z.object({ line: z.number().int().nonnegative() }).passthrough(),
  }).passthrough(),
  metaVariables: z.object({
    single: z.object({
      TYPE: z.object({ text: z.string() }).passthrough(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const astOutputSchema = z.array(astMatchSchema);

function keyOf(boundary) {
  return `${boundary.file}:${boundary.line}`;
}

function loadMatches() {
  const localBinary = join(root, 'node_modules/.bin/ast-grep');
  const binary = existsSync(localBinary) ? localBinary : 'ast-grep';
  const result = spawnSync(
    binary,
    ['run', '-p', pattern, '--lang', 'ts', '--json=compact', ...targets],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ast-grep failed with status ${String(result.status)}: ${result.stderr.trim()}`);
  }
  return astOutputSchema.parse(JSON.parse(result.stdout));
}

function findViolations(inventory, matches) {
  const violations = [];
  const owned = new Map();
  for (const boundary of inventory.boundaries) {
    const key = keyOf(boundary);
    if (owned.has(key)) violations.push(`${key}: duplicate inventory ownership`);
    owned.set(key, boundary);
  }

  const observed = new Set();
  for (const match of matches) {
    const boundary = {
      file: match.file,
      line: match.range.start.line + 1,
      schema: match.metaVariables.single.TYPE.text,
    };
    const key = keyOf(boundary);
    observed.add(key);
    const entry = owned.get(key);
    if (entry === undefined) {
      violations.push(`${key}: unowned JSON.parse(...) as Type boundary (schema: ${boundary.schema})`);
    } else if (entry.schema !== boundary.schema) {
      violations.push(`${key}: inventory schema "${entry.schema}" does not match AST schema "${boundary.schema}"`);
    }
  }

  for (const boundary of inventory.boundaries) {
    const key = keyOf(boundary);
    if (!observed.has(key)) violations.push(`${key}: stale inventory entry has no AST match`);
  }
  return violations.sort();
}

const inventory = inventorySchema.parse(JSON.parse(readFileSync(inventoryPath, 'utf8')));
const matches = loadMatches();
const violations = findViolations(inventory, matches);
const jsonOutput = process.argv.includes('--json');

if (violations.length > 0) {
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify({ status: 'fail', count: matches.length, violations }, null, 2)}\n`);
  } else {
    process.stderr.write(`${violations.join('\n')}\n`);
  }
  process.exitCode = 1;
} else {
  const message = 'RUNTIME_BOUNDARY_INVENTORY_PASS';
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify({ status: 'pass', message, count: matches.length }, null, 2)}\n`);
  } else {
    process.stdout.write(`${message} (${String(matches.length)} owned boundaries)\n`);
  }
}
