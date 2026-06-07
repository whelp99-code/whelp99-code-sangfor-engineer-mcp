import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import {
  getEmbeddingProvider,
  resetEmbeddingProviderCache,
  resolveEmbeddingBackendFromEnv
} from '../packages/sangfor-rag/src/embedding-provider.js';
import {
  isMimoViaLitellm,
  resolveLitellmBaseUrl,
  resolveLitellmEmbeddingModel
} from '../packages/sangfor-rag/src/litellm-config.js';
import { createMimoRerankFromEnv, resolveMimoBaseUrl, resolveMimoBillingMode } from '../packages/sangfor-rag/src/mimo-rerank-provider.js';
import { probeEmbeddingsEndpoint } from '../packages/sangfor-rag/src/openai-embeddings-client.js';

loadEnvFile('.env');

async function main() {
  resetEmbeddingProviderCache();
  const embed = await getEmbeddingProvider();
  const embedHealth = await embed.healthCheck();
  const mimo = createMimoRerankFromEnv();
  const mimoHealth = mimo ? await mimo.healthCheck() : { ok: false, detail: 'disabled' };
  const viaLitellm = isMimoViaLitellm();
  const mimoBase = viaLitellm ? resolveLitellmBaseUrl() : resolveMimoBaseUrl();
  const mimoBilling = viaLitellm ? 'litellm-proxy' : resolveMimoBillingMode();
  const litellmBase = resolveLitellmBaseUrl();
  const litellmEmbedProbe = await probeEmbeddingsEndpoint(
    litellmBase,
    process.env.SANGFOR_LITELLM_API_KEY?.trim() || process.env.LITELLM_MASTER_KEY?.trim(),
    'authorization'
  );
  console.log(JSON.stringify({
    embeddingProvider: embed.name,
    embeddingProviderRequested: resolveEmbeddingBackendFromEnv(),
    embeddingHealth: embedHealth,
    dimensions: embed.dimensions,
    litellmBaseUrl: litellmBase,
    litellmEmbeddingModel: resolveLitellmEmbeddingModel(),
    litellmEmbeddingsAvailable: litellmEmbedProbe,
    mimoRerankEnabled: Boolean(mimo),
    mimoViaLitellm: viaLitellm,
    mimoBillingMode: mimoBilling,
    mimoBaseUrl: mimoBase,
    mimoRerankHealth: mimoHealth,
    allowCloudRag: process.env.SANGFOR_ALLOW_CLOUD_RAG === '1'
  }, null, 2));
  process.exit(embedHealth.ok ? 0 : 1);
}

main();
