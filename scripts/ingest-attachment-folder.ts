import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { ingestDocument, exportRagIndexSummary, loadRagIndex } from '../packages/sangfor-rag/src/index.js';
import type { ProductCode } from '../packages/shared/src/index.js';

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.md', '.markdown', '.txt', '.html', '.htm', '.docx', '.pptx', '.xlsx', '.xlsm']);
const DEFAULT_ROOT = '/Users/jmpark/Documents/SANGFOR/Attachment';

interface IngestedFile {
  filePath: string;
  product: ProductCode;
  version?: string;
  chunkCount: number;
}

interface SkippedFile {
  filePath: string;
  reason: string;
}

function walkFiles(root: string): string[] {
  const entries = readdirSync(root).flatMap(entry => {
    const fullPath = join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return walkFiles(fullPath);
    return stat.isFile() ? [fullPath] : [];
  });
  return entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function shouldSkip(filePath: string): string | undefined {
  const name = basename(filePath);
  if (name === '.DS_Store') return 'macOS metadata';
  if (name.startsWith('~$')) return 'office temporary file';
  if (!SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase())) return 'unsupported extension';
  return undefined;
}

function inferProduct(filePath: string): ProductCode {
  const value = filePath.toLowerCase();
  if (/\b(3\. epp|endpoint|endpoint secure|epp|edr|asec)\b/i.test(filePath)) return 'ENDPOINT_SECURE';
  if (/\b(4\. cyber command|cyber command|soc|siem)\b/i.test(filePath)) return 'CYBER_COMMAND';
  if (/\b(2\. iag|iag|iam|internet access gateway|ngaf|network secure|nsf|sase)\b/i.test(filePath)) return 'IAG';
  if (/\b(5\. hci|6\. vdi|ske|kubernetes|hci|acloud|asv|scp|vdi|adesk|astor|vmware|veeam)\b/i.test(filePath)) return 'HCI';
  if (value.includes('sangfor')) return 'HCI';
  return 'HCI';
}

function inferVersion(filePath: string): string | undefined {
  const normalized = filePath.replace(/_/g, ' ');
  const match = normalized.match(/\b[vV]?\s*(\d+\.\d+(?:\.\d+){0,2})\b/);
  return match?.[1];
}

const [rootArg, productArg] = process.argv.slice(2).filter(arg => arg !== '--');
const root = rootArg ?? DEFAULT_ROOT;
if (!existsSync(root)) {
  console.error(`Attachment folder does not exist: ${root}`);
  process.exit(1);
}

const forcedProduct = productArg as ProductCode | undefined;
const ingested: IngestedFile[] = [];
const skipped: SkippedFile[] = [];
const existingFilePaths = new Set(loadRagIndex().chunks.map(chunk => chunk.filePath));

for (const filePath of walkFiles(root)) {
  const skipReason = shouldSkip(filePath);
  if (skipReason) {
    skipped.push({ filePath, reason: skipReason });
    continue;
  }
  if (existingFilePaths.has(filePath)) {
    skipped.push({ filePath, reason: 'already indexed' });
    continue;
  }

  const product = forcedProduct ?? inferProduct(filePath);
  const version = inferVersion(filePath);
  try {
    const result = await ingestDocument({
      filePath,
      product,
      version,
      title: basename(filePath),
      sourceType: 'manual',
      trustLevel: 'internal'
    });
    ingested.push({ filePath, product, version, chunkCount: result.chunkCount });
    existingFilePaths.add(filePath);
  } catch (error) {
    skipped.push({ filePath, reason: error instanceof Error ? error.message : String(error) });
  }
}

const report = {
  root,
  ingestedCount: ingested.length,
  skippedCount: skipped.length,
  totalChunksAdded: ingested.reduce((sum, file) => sum + file.chunkCount, 0),
  byProduct: ingested.reduce<Record<string, number>>((acc, file) => {
    acc[file.product] = (acc[file.product] ?? 0) + file.chunkCount;
    return acc;
  }, {}),
  rag: exportRagIndexSummary(),
  ingested,
  skipped
};

writeFileSync('data/rag/attachment-ingest-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
