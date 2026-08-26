import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { parse, relative, resolve } from 'node:path';
import { z } from 'zod';
import { AuthorityCutoverError } from './errors.js';
import { parseCutoverRecord, canonicalRecordSet } from './records.js';
import type { CutoverRecord } from './types.js';

export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(jsonValueSchema),
]));
export const jsonObjectSchema = z.record(jsonValueSchema);

export type SourceBinding = { readonly tenantId: string; readonly projectId: string; readonly sourceRoot: string };
export type SourceFile = {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
};

function assertNoSymlinkComponents(path: string): void {
  const root = parse(path).root; const components = path.slice(root.length).split(/[\\/]/u).filter(Boolean);
  let cursor = root;
  for (const component of components) {
    cursor = resolve(cursor, component);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new AuthorityCutoverError('CUTOVER_SOURCE_SYMLINK_REFUSED', [cursor]);
  }
}

export function filesBelow(root: string, accept: (path: string) => boolean): readonly SourceFile[] {
  const absoluteRoot = resolve(root);
  if (!existsSync(absoluteRoot) || !lstatSync(absoluteRoot).isDirectory() || lstatSync(absoluteRoot).isSymbolicLink()) {
    throw new AuthorityCutoverError('CUTOVER_SOURCE_UNSUPPORTED', [root]);
  }
  assertNoSymlinkComponents(absoluteRoot);
  const paths: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = resolve(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new AuthorityCutoverError('CUTOVER_SOURCE_SYMLINK_REFUSED', [path]);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile() && accept(relative(absoluteRoot, path))) paths.push(path);
    }
  };
  visit(absoluteRoot);
  return paths.map((path) => {
    const bytes = readFileSync(path);
    return {
      absolutePath: path,
      relativePath: relative(absoluteRoot, path),
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

export function parseJsonFile(file: SourceFile, schema: z.ZodType<readonly Readonly<Record<string, unknown>>[]>, binding: SourceBinding): readonly CutoverRecord[] {
  let raw: unknown;
  try { raw = JSON.parse(file.bytes.toString('utf8')); }
  catch (error) { throw new AuthorityCutoverError('CUTOVER_SOURCE_INVALID', [file.relativePath], { cause: error }); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AuthorityCutoverError('CUTOVER_SOURCE_INVALID', [file.relativePath], { cause: parsed.error });
  return parsed.data.map((payload, ordinal) => record(file, ordinal, payload, binding));
}

export function parseJsonSingle(file: SourceFile, schema: z.ZodType<Readonly<Record<string, unknown>>>, binding: SourceBinding): readonly CutoverRecord[] {
  let raw: unknown;
  try { raw = JSON.parse(file.bytes.toString('utf8')); }
  catch (error) { throw new AuthorityCutoverError('CUTOVER_SOURCE_INVALID', [file.relativePath], { cause: error }); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AuthorityCutoverError('CUTOVER_SOURCE_INVALID', [file.relativePath], { cause: parsed.error });
  return [record(file, 0, parsed.data, binding)];
}

export function parseJsonLines(file: SourceFile, schema: z.ZodType<Readonly<Record<string, unknown>>>, binding: SourceBinding): readonly CutoverRecord[] {
  return file.bytes.toString('utf8').split('\n').flatMap((line, ordinal) => {
    if (line.trim().length === 0) return [];
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch (error) { throw new AuthorityCutoverError('CUTOVER_SOURCE_INVALID', [`${file.relativePath}:${ordinal + 1}`], { cause: error }); }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new AuthorityCutoverError('CUTOVER_SOURCE_INVALID', [`${file.relativePath}:${ordinal + 1}`], { cause: parsed.error });
    return [record(file, ordinal, parsed.data, binding)];
  });
}

const nestedReportIdSchema = z.object({ report: z.object({ reportId: z.string().min(1) }).passthrough() }).passthrough();
function record(file: SourceFile, ordinal: number, payload: Readonly<Record<string, unknown>>, binding: SourceBinding): CutoverRecord {
  const nestedReport = nestedReportIdSchema.safeParse(payload);
  const keyValue = payload['id'] ?? payload['eventId'] ?? payload['runId'] ?? payload['reportId'] ?? payload['strategyId']
    ?? payload['deviceId'] ?? payload['product'] ?? payload['lastHash'] ?? payload['hash'] ?? (nestedReport.success ? nestedReport.data.report.reportId : undefined);
  if (typeof keyValue !== 'string' || keyValue.length === 0) {
    throw new AuthorityCutoverError('CUTOVER_STABLE_KEY_MISSING', [`${file.relativePath}:${ordinal + 1}`]);
  }
  return parseCutoverRecord({
    key: `${file.relativePath.length}:${file.relativePath}:${keyValue}${file.relativePath.endsWith('.jsonl') ? `:${ordinal}` : ''}`,
    payload,
    provenance: { ...binding, sourceRoot: resolve(binding.sourceRoot), source: file.relativePath, ordinal, sourceSha256: file.sha256 },
  });
}

export function sourceSnapshot(records: readonly CutoverRecord[]): {
  readonly highWaterMark: string;
  readonly records: readonly CutoverRecord[];
} {
  return { highWaterMark: canonicalRecordSet(records).digest, records };
}
