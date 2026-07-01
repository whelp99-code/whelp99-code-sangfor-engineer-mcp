import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeReplacementCoverage, loadWorkAtoms } from '../../../packages/sangfor-competency/src/index.js';
import { resolveRepoData } from '../../../packages/shared/src/index.js';
import { listSpecCoverage } from '../../../packages/sangfor-spec/src/index.js';
import { listCapabilitySafety, loadMaturityPolicy } from '../../../packages/sangfor-safety/src/index.js';
import { analyzeProject, generateConfigPlanAsync } from '../../../packages/sangfor-planner/src/index.js';
import { listSeedManuals, searchManuals } from '../../../packages/sangfor-knowledge/src/index.js';
import { listSeedWiki, searchWiki } from '../../../packages/sangfor-wiki/src/index.js';
import { ragSearch, exportRagIndexSummary, getEmbeddingProvider, resetEmbeddingProviderCache } from '../../../packages/sangfor-rag/src/index.js';
import { createMimoRerankFromEnv, resolveMimoBaseUrl, resolveMimoBillingMode } from '../../../packages/sangfor-rag/src/mimo-rerank-provider.js';
import { isMimoViaLitellm, resolveLitellmBaseUrl, resolveLitellmEmbeddingModel } from '../../../packages/sangfor-rag/src/litellm-config.js';
import { probeEmbeddingsEndpoint } from '../../../packages/sangfor-rag/src/openai-embeddings-client.js';
import { submitFeedback } from '../../../packages/sangfor-feedback/src/index.js';
import { persistConfigPlan, persistFeedbackEvent, storeHealthCheck, isStoreEnabled } from '../../../packages/sangfor-store/src/index.js';
import { PRODUCTS } from '../../../packages/shared/src/index.js';
import {
  analyzeCustomerRequirements,
  discoverProductConsole,
  importExcelRequirementList,
  generateExcelBasedChangePlan
} from '../../../packages/sangfor-product-adapters/src/index.js';

export const RAG_INDEX = process.env.SANGFOR_RAG_INDEX ?? 'data/rag/index.json';

export function getSummary() {
  const rag = exportRagIndexSummary(RAG_INDEX);
  return {
    manualCount: listSeedManuals().length,
    wikiCount: listSeedWiki().length,
    rag,
    products: PRODUCTS,
    storeEnabled: isStoreEnabled()
  };
}

export function getKnowledge(product: string, type: string) {
  const items = type === 'wiki'
    ? searchWiki({ product, query: ' ', limit: 20 })
    : searchManuals({ product, query: ' ', limit: 20 });
  return { product, type, items };
}

export async function postAnalyzeProject(body: Record<string, unknown>) {
  return analyzeProject(body as unknown as Parameters<typeof analyzeProject>[0]);
}

export async function postGenerateConfigPlan(body: Record<string, unknown>) {
  const plan = await generateConfigPlanAsync(body as unknown as Parameters<typeof generateConfigPlanAsync>[0]);
  const dbId = await persistConfigPlan(plan).catch(() => null);
  return dbId ? { ...plan, persistedId: dbId } : plan;
}

export async function postRagSearch(body: { query?: string; product?: string; version?: string; limit?: number }) {
  if (!body.query?.trim()) throw new Error('query is required');
  return ragSearch({
    query: body.query,
    product: body.product,
    version: body.version,
    limit: body.limit ?? 10,
    indexPath: RAG_INDEX
  });
}

export async function postDiscoverConsole(body: Record<string, unknown>) {
  return discoverProductConsole(body as Parameters<typeof discoverProductConsole>[0]);
}

export async function postAnalyzeRequirements(body: Record<string, unknown>) {
  return analyzeCustomerRequirements(body as unknown as Parameters<typeof analyzeCustomerRequirements>[0]);
}

export async function postImportExcel(body: {
  filePath?: string;
  fileName?: string;
  contentBase64?: string;
  sheetName?: string;
  prioritizeOnly?: boolean;
  generatePlan?: boolean;
}) {
  let filePath = body.filePath?.trim();
  if (body.contentBase64 && body.fileName) {
    const dir = join(process.cwd(), 'data', 'tmp');
    mkdirSync(dir, { recursive: true });
    filePath = join(dir, `upload-${Date.now()}-${body.fileName.replace(/[^\w.-]/g, '_')}`);
    writeFileSync(filePath, Buffer.from(body.contentBase64, 'base64'));
  }
  if (!filePath) throw new Error('filePath or contentBase64+fileName required');

  const imported = importExcelRequirementList({
    filePath,
    sheetName: body.sheetName,
    prioritizeOnly: body.prioritizeOnly ?? true
  });

  if (body.generatePlan) {
    const plan = generateExcelBasedChangePlan({
      filePath,
      rows: imported.rows,
      sheetName: body.sheetName,
      prioritizeOnly: body.prioritizeOnly ?? true
    });
    return { imported, plan };
  }
  return { imported };
}

export async function postFeedback(body: Record<string, unknown>) {
  const event = submitFeedback(body as Parameters<typeof submitFeedback>[0]);
  const dbId = await persistFeedbackEvent(event).catch(() => null);
  return dbId ? { ...event, persistedId: dbId } : event;
}

export async function getStoreHealth() {
  const health = await storeHealthCheck();
  return { ...health, enabled: isStoreEnabled() };
}

export async function getEmbeddingHealth() {
  resetEmbeddingProviderCache();
  const embed = await getEmbeddingProvider();
  const embedHealth = await embed.healthCheck();
  const mimo = createMimoRerankFromEnv();
  const mimoHealth = mimo ? await mimo.healthCheck() : { ok: false, detail: 'disabled' };
  const viaLitellm = isMimoViaLitellm();
  const mimoBase = viaLitellm ? resolveLitellmBaseUrl() : resolveMimoBaseUrl();
  const mimoBilling = viaLitellm ? 'litellm-proxy' : resolveMimoBillingMode();
  const litellmKey = process.env.SANGFOR_LITELLM_API_KEY?.trim() || process.env.LITELLM_MASTER_KEY?.trim();
  const litellmEmbedProbe = await probeEmbeddingsEndpoint(resolveLitellmBaseUrl(), litellmKey, 'authorization');
  return {
    embeddingProvider: embed.name,
    embeddingHealth: embedHealth,
    dimensions: embed.dimensions,
    litellmBaseUrl: resolveLitellmBaseUrl(),
    litellmEmbeddingModel: resolveLitellmEmbeddingModel(),
    litellmEmbeddingsAvailable: litellmEmbedProbe,
    mimoRerankEnabled: Boolean(mimo),
    mimoViaLitellm: viaLitellm,
    mimoBillingMode: mimoBilling,
    mimoBaseUrl: mimoBase,
    mimoRerankHealth: mimoHealth,
    allowCloudRag: process.env.SANGFOR_ALLOW_CLOUD_RAG === '1'
  };
}

// ── Field-engineer automation visibility (read-only panels) ──
export function getFieldEngineerCoverage() {
  const atoms = loadWorkAtoms();
  // Human-facing surface MUST apply the same honest verification as the MCP path:
  // evidence must resolve to a real artifact under the output root (no prose/dir/absolute).
  const evidenceRoot = resolveRepoData('.', 'SANGFOR_OUTPUT_ROOT');
  const maturityPolicy = loadMaturityPolicy().entries.map(({ product, capabilityId, maturity }) => ({ product, capabilityId, maturity }));
  return { coverage: computeReplacementCoverage(atoms, { evidenceRoot, maturityPolicy }), atoms };
}

export function getSpecCoverage() {
  return { specs: listSpecCoverage(), safety: listCapabilitySafety() };
}

export function getDiagnoses() {
  const dir = join(process.cwd(), 'outputs', 'diagnosis');
  if (!existsSync(dir)) return { diagnoses: [] };
  const diagnoses = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      const summary = text.match(/요약:[^\n]*/)?.[0] ?? '';
      const verdict = text.match(/종합 판정\(ok\):[^\n]*/)?.[0] ?? '';
      return { file: f, summary, verdict, chars: text.length };
    });
  return { diagnoses };
}
