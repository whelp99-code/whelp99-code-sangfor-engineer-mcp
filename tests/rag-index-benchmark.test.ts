import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deriveRegisteredProducts } from '../packages/sangfor-rag/src/benchmark-registry.js';
import { parseRuntimeMetadata } from '../packages/sangfor-rag/src/benchmark-runner.js';

const JsonRecordSchema = z.record(z.string(), z.unknown());
const ReportSchema = z.object({
  corpusDigest: z.string(),
  generatedGrowthDigest: z.string(),
  resultDigest: z.string(),
  dataset: z.object({ baseChunkCount: z.number(), chunkCount: z.number() }).passthrough(),
  queries: z.array(z.object({ id: z.string(), candidateIds: z.array(z.string()) }).passthrough()),
  metrics: z.object({ recallAtK: z.number(), hitRateAtK: z.number() }).passthrough(),
  coverage: z.object({ missingProducts: z.array(z.string()), products: z.array(z.string()) }).passthrough(),
  forbiddenHitCount: z.number(),
  runtime: JsonRecordSchema
}).passthrough();

const ROOT = process.cwd();
const CLI = join(ROOT, 'scripts', 'rag-index-benchmark.ts');
const CORPUS = join(ROOT, 'data', 'evals', 'rag', 'project-completeness-v1.json');

type JsonRecord = Record<string, unknown>;

function run(path = CORPUS, growth = 1): ReturnType<typeof spawnSync> {
  return spawnSync('pnpm', ['exec', 'tsx', CLI, '--queries', path, '--backends', 'exact', '--growth-multiplier', String(growth), '--json'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): JsonRecord {
  if (!isJsonRecord(value)) throw new TypeError('expected JSON object');
  return value;
}

function corpus(): JsonRecord {
  const parsed: unknown = JSON.parse(readFileSync(CORPUS, 'utf8'));
  return record(parsed);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withMutation(mutate: (value: JsonRecord) => void, refreshDigest = true): ReturnType<typeof spawnSync> {
  const dir = mkdtempSync(join(tmpdir(), 'rag-benchmark-'));
  try {
    const value = corpus();
    mutate(value);
    if (refreshDigest) {
      const { corpusDigest: _digest, ...stable } = value;
      value.corpusDigest = createHash('sha256').update(canonical(stable)).digest('hex');
    }
    const path = join(dir, 'corpus.json');
    writeFileSync(path, JSON.stringify(value));
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rows(value: JsonRecord, key: 'chunks' | 'queries'): JsonRecord[] {
  const entries = value[key];
  if (!Array.isArray(entries) || !entries.every(isJsonRecord)) throw new TypeError(`expected ${key} array`);
  return entries;
}

function queryProduct(query: JsonRecord): string | undefined {
  const product = record(query.filters).product;
  return typeof product === 'string' ? product : undefined;
}

function text(value: string | Buffer | null): string {
  if (typeof value === 'string') return value;
  return value?.toString('utf8') ?? '';
}

function expectRefusal(result: ReturnType<typeof spawnSync>, code: string): void {
  expect(result.status).not.toBe(0);
  expect(text(result.stderr)).toContain(code);
}

describe('rag index benchmark corpus boundary', () => {
  it('refuses before ranking when a valid corpus misses exactly one registry-derived product', () => {
    const registered = deriveRegisteredProducts();
    const baseline = corpus();
    const baselineProducts = new Set(rows(baseline, 'queries').map(queryProduct).filter((product): product is string => product !== undefined));
    expect(registered.products.filter((product) => !baselineProducts.has(product))).toEqual([]);
    const missingProduct = registered.products.find((product) => baselineProducts.has(product));
    if (!missingProduct) throw new TypeError('committed corpus has no registry-derived product query');
    const retainedProducts = new Set([...baselineProducts].filter((product) => product !== missingProduct));
    expect(registered.products.filter((product) => !retainedProducts.has(product))).toEqual([missingProduct]);
    const result = withMutation((value) => {
      value.queries = rows(value, 'queries').filter((query) => queryProduct(query) !== missingProduct);
      value.chunks = rows(value, 'chunks').filter((chunk) => chunk.product !== missingProduct);
    });
    expectRefusal(result, 'PRODUCT_COVERAGE_INCOMPLETE');
    expect(text(result.stderr)).toContain(missingProduct);
  });

  it('accepts one additional synthetic product without treating it as registry coverage', () => {
    const registered = deriveRegisteredProducts();
    const extraProduct = 'SYNTHETIC_UNREGISTERED_PRODUCT';
    expect(registered.products).not.toContain(extraProduct);
    const extraId = 'zz-extra-product';
    const extraQueryId = 'zz-query-extra-product';
    const result = withMutation((value) => {
      const chunkTemplate = rows(value, 'chunks')[0];
      const queryTemplate = rows(value, 'queries')[0];
      if (!chunkTemplate || !queryTemplate) throw new TypeError('benchmark corpus templates are missing');
      rows(value, 'chunks').push({ ...chunkTemplate, id: extraId, product: extraProduct, title: 'Synthetic extra product', text: 'extra_product_oracle', filePath: 'synthetic/extra-product.md' });
      rows(value, 'queries').push({ ...queryTemplate, id: extraQueryId, text: 'extra_product_oracle', filters: { product: extraProduct }, expectedIds: [extraId], forbiddenIds: [] });
      rows(value, 'chunks').sort((left, right) => String(left.id).localeCompare(String(right.id)));
      rows(value, 'queries').sort((left, right) => String(left.id).localeCompare(String(right.id)));
    });
    expect(result.status).toBe(0);
    const report = ReportSchema.parse(JSON.parse(text(result.stdout)));
    expect(report.coverage.products).not.toContain(extraProduct);
    expect(report.queries.find((query) => query.id === extraQueryId)?.candidateIds).toContain(extraId);
  });

  it('refuses a missing expected result', () => {
    const result = withMutation((value) => {
      rows(value, 'queries')[0].expectedIds = ['missing-id'];
    });
    expectRefusal(result, 'EXPECTED_RESULT_MISSING');
  });

  it('refuses a forbidden or cross-scope expected candidate', () => {
    const result = withMutation((value) => {
      const query = rows(value, 'queries').find((row) => row.id === 'q-scope-isolation');
      if (query) query.expectedIds = ['hci-cross-project'];
    });
    expectRefusal(result, 'EXPECTED_RESULT_OUT_OF_SCOPE');
  });

  it('keeps tenant, project, and actor ACL rows out of the candidate audit', () => {
    const result = run();
    expect(result.status).toBe(0);
    const report = ReportSchema.parse(JSON.parse(text(result.stdout)));
    const audit = report.queries.find((query) => query.id === 'q-scope-isolation');
    expect(audit?.candidateIds).not.toContain('hci-cross-tenant');
    expect(audit?.candidateIds).not.toContain('hci-cross-project');
    expect(audit?.candidateIds).not.toContain('hci-acl-denied');
  });

  it.each([
    ['trustLevel', 'official', 'hci-filter-draft'],
    ['sourceType', 'manual', 'hci-filter-wiki'],
    ['version', '1.0', 'hci-filter-version']
  ])('refuses a %s filter leak before ranking', (field, value, leakedId) => {
    const result = withMutation((document) => {
      const leaked = rows(document, 'chunks').find((row) => row.id === leakedId);
      if (leaked) leaked[field] = value;
    });
    expectRefusal(result, 'FORBIDDEN_CANDIDATE');
  });

  it('refuses cross-scope and ACL rows if either reaches the candidate set', () => {
    const crossScope = withMutation((value) => {
      const leaked = rows(value, 'chunks').find((row) => row.id === 'hci-cross-project');
      if (leaked) leaked.projectId = 'project-alpha';
    });
    expectRefusal(crossScope, 'FORBIDDEN_CANDIDATE');
    const acl = withMutation((value) => {
      const leaked = rows(value, 'chunks').find((row) => row.id === 'hci-acl-denied');
      if (leaked) leaked.aclActorIds = [];
    });
    expectRefusal(acl, 'FORBIDDEN_CANDIDATE');
  });

  it('refuses mixed or missing embedding cohort metadata before ranking', () => {
    const mixed = withMutation((value) => {
      rows(value, 'chunks')[0].embeddingModel = 'other-model';
    });
    expectRefusal(mixed, 'MIXED_EMBEDDING_COHORT');
    const mixedBackend = withMutation((value) => {
      rows(value, 'chunks')[0].embeddingBackend = 'rapid-mlx';
    });
    expectRefusal(mixedBackend, 'MIXED_EMBEDDING_COHORT');
    const missing = withMutation((value) => {
      delete rows(value, 'chunks')[0].embeddingBackend;
    });
    expectRefusal(missing, 'CORPUS_SCHEMA_INVALID');
  });

  it('refuses wrong vector dimensions before ranking', () => {
    const result = withMutation((value) => {
      rows(value, 'chunks')[0].vectorDims = 64;
    });
    expectRefusal(result, 'EMBEDDING_DIMENSIONS_MISMATCH');
  });

  it('refuses nondeterministic order, duplicate ids, and unknown fields', () => {
    const unordered = withMutation((value) => rows(value, 'chunks').reverse());
    expectRefusal(unordered, 'CORPUS_ORDER_NONDETERMINISTIC');
    const duplicate = withMutation((value) => rows(value, 'chunks')[1].id = rows(value, 'chunks')[0].id);
    expectRefusal(duplicate, 'DUPLICATE_ID');
    const unknown = withMutation((value) => { value.surprise = true; });
    expectRefusal(unknown, 'CORPUS_SCHEMA_INVALID');
  });

  it('refuses a false hit for a no-result query', () => {
    const result = withMutation((value) => {
      const query = rows(value, 'queries').find((row) => row.id === 'q-no-result');
      if (query) record(query.scope).projectId = 'project-alpha';
    });
    expectRefusal(result, 'NO_RESULT_FALSE_HIT');
  });

  it('refuses missing hardware/runtime metadata', () => {
    expect(() => parseRuntimeMetadata({ node: 'v24', platform: 'linux', arch: 'x64', cpu: 'synthetic', cores: 8 })).toThrow('RUNTIME_METADATA_MISSING');
  });

  it('reports hardware/runtime metadata and detects corpus digest drift', () => {
    const result = run();
    expect(result.status).toBe(0);
    const report = ReportSchema.parse(JSON.parse(text(result.stdout)));
    expect(report.runtime).toMatchObject({ node: expect.any(String), platform: expect.any(String), arch: expect.any(String), cpu: expect.any(String), cores: expect.any(Number), memoryBytes: expect.any(Number) });
    expect(report.corpusDigest).toMatch(/^[a-f0-9]{64}$/);
    const drift = withMutation((value) => { rows(value, 'chunks')[0].text = 'sanitized deterministic changed text'; }, false);
    expectRefusal(drift, 'CORPUS_DIGEST_DRIFT');
  });
});

describe('rag index benchmark deterministic growth and quality gates', () => {
  it('generates byte-identical 10x digests and result-bearing output', () => {
    const first = ReportSchema.parse(JSON.parse(execFileSync('pnpm', ['exec', 'tsx', CLI, '--queries', CORPUS, '--backends', 'exact', '--growth-multiplier', '10', '--json'], { cwd: ROOT, encoding: 'utf8' })));
    const secondResult = run(CORPUS, 10);
    expect(secondResult.status).toBe(0);
    const second = ReportSchema.parse(JSON.parse(text(secondResult.stdout)));
    expect(first.generatedGrowthDigest).toBe(second.generatedGrowthDigest);
    expect(first.resultDigest).toBe(second.resultDigest);
    expect(first.dataset.chunkCount).toBe(first.dataset.baseChunkCount * 10);
  });

  it('keeps volatile latency out of the deterministic result digest', () => {
    const result = run(CORPUS, 10);
    expect(result.status).toBe(0);
    const raw = record(JSON.parse(text(result.stdout)));
    const report = ReportSchema.parse(raw);
    const stable = JSON.stringify({ queries: raw.queries, metrics: raw.metrics, growth: report.generatedGrowthDigest });
    expect(report.resultDigest).toBe(createHash('sha256').update(stable).digest('hex'));
  });

  it('derives full product coverage and requires exact recall with zero forbidden hits', () => {
    const result = run();
    expect(result.status).toBe(0);
    const report = ReportSchema.parse(JSON.parse(text(result.stdout)));
    expect(report.coverage.missingProducts).toEqual([]);
    expect(report.coverage.products.length).toBeGreaterThan(0);
    expect(report.forbiddenHitCount).toBe(0);
    expect(report.metrics.recallAtK).toBe(1);
    expect(report.metrics.hitRateAtK).toBe(1);
  });

  it('supports help and strictly refuses unsupported CLI input', () => {
    const help = spawnSync('pnpm', ['exec', 'tsx', CLI, '--help'], { cwd: ROOT, encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--growth-multiplier');
    expect(run(CORPUS, 0).status).not.toBe(0);
    const bad = spawnSync('pnpm', ['exec', 'tsx', CLI, '--unknown'], { cwd: ROOT, encoding: 'utf8' });
    expect(bad.status).not.toBe(0);
  });
});
