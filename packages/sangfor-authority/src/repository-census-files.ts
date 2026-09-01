import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';

export type RepositoryFiles = {
  readonly sourcePaths: readonly string[];
  readonly packageNames: ReadonlySet<string>;
  readonly prismaModels: ReadonlyMap<string, string>;
  readonly projectScopedTables: ReadonlySet<string>;
  readonly targetTables: ReadonlySet<string>;
  readonly rlsTables: ReadonlySet<string>;
};

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const EXCLUDED_SEGMENTS = new Set(['tests', 'test', 'dist', 'node_modules']);
const packageSchema = z.object({ name: z.string().min(1) }).passthrough();

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot);
}

function walkFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED_SEGMENTS.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

function sourcePaths(root: string): readonly string[] {
  return ['apps', 'packages', 'scripts']
    .flatMap((directory) => walkFiles(join(root, directory)))
    .filter((path) => SOURCE_EXTENSIONS.has(extension(path)) && !path.endsWith('.d.ts'))
    .sort();
}

function packageNames(root: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const parent of ['apps', 'packages']) {
    const directory = join(root, parent);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(directory, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      names.add(packageSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8'))).name);
    }
  }
  return names;
}

function prismaModels(root: string): {
  readonly blocks: ReadonlyMap<string, string>;
  readonly projectScoped: ReadonlySet<string>;
} {
  const schemaPath = join(root, 'prisma/schema.prisma');
  if (!existsSync(schemaPath)) return { blocks: new Map(), projectScoped: new Set() };
  const schema = readFileSync(schemaPath, 'utf8');
  const blocks = new Map<string, string>();
  const projectScoped = new Set<string>();
  for (const match of schema.matchAll(/^model\s+([A-Za-z_$][\w$]*)\s*\{([\s\S]*?)^\}/gmu)) {
    const name = match[1];
    const body = match[2];
    if (!name || body === undefined) continue;
    blocks.set(name, body.replace(/\s+/gu, ' ').trim());
    if (/^\s*projectId\s+String\b/mu.test(body)) projectScoped.add(name);
  }
  return { blocks, projectScoped };
}

function sqlMetadata(root: string): {
  readonly tables: ReadonlySet<string>;
  readonly rls: ReadonlySet<string>;
} {
  const tables = new Set<string>();
  const rls = new Set<string>();
  for (const path of walkFiles(join(root, 'prisma/migrations')).filter((file) => file.endsWith('.sql'))) {
    const sql = readFileSync(path, 'utf8');
    for (const match of sql.matchAll(/CREATE\s+TABLE\s+"([A-Za-z_$][\w$]*)"/giu)) {
      if (match[1]) tables.add(match[1]);
    }
    const enabled = new Set([...sql.matchAll(/ALTER\s+TABLE\s+"([A-Za-z_$][\w$]*)"\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/giu)].flatMap((match) => match[1] ? [match[1]] : []));
    const forced = new Set([...sql.matchAll(/ALTER\s+TABLE\s+"([A-Za-z_$][\w$]*)"\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/giu)].flatMap((match) => match[1] ? [match[1]] : []));
    const policy = new Set([...sql.matchAll(/CREATE\s+POLICY\s+"[^"]+"\s+ON\s+"([A-Za-z_$][\w$]*)"/giu)].flatMap((match) => match[1] ? [match[1]] : []));
    for (const table of enabled) if (forced.has(table) && policy.has(table)) rls.add(table);
    if (/ENABLE ROW LEVEL SECURITY/u.test(sql) && /FORCE ROW LEVEL SECURITY/u.test(sql) && /CREATE POLICY/u.test(sql)) {
      for (const array of sql.matchAll(/FOREACH\s+table_name\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]\s+LOOP/giu)) {
        for (const quoted of (array[1] ?? '').matchAll(/'([A-Za-z_$][\w$]*)'/gu)) if (quoted[1]) rls.add(quoted[1]);
      }
    }
  }
  return { tables, rls };
}

export function collectRepositoryFiles(root: string): RepositoryFiles {
  const models = prismaModels(root);
  const sql = sqlMetadata(root);
  return {
    sourcePaths: sourcePaths(root),
    packageNames: packageNames(root),
    prismaModels: models.blocks,
    projectScopedTables: models.projectScoped,
    targetTables: new Set([...models.blocks.keys(), ...sql.tables]),
    rlsTables: sql.rls,
  };
}

export function repositoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}
