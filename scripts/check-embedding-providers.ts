import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { getEmbeddingProvider, resetEmbeddingProviderCache } from '../packages/sangfor-rag/src/embedding-provider.js';
import { createMimoRerankFromEnv } from '../packages/sangfor-rag/src/mimo-rerank-provider.js';
import { probeEmbeddingsEndpoint } from '../packages/sangfor-rag/src/openai-embeddings-client.js';

loadEnvFile('.env');

async function main() {
  resetEmbeddingProviderCache();
  const embed = await getEmbeddingProvider();
  const embedHealth = await embed.healthCheck();
  const mimo = createMimoRerankFromEnv();
  const mimoHealth = mimo ? await mimo.healthCheck() : { ok: false, detail: 'disabled' };
  const mimoBase = process.env.SANGFOR_MIMO_BASE_URL ?? 'https://api.xiaomimimo.com/v1';
  const mimoEmbedProbe = await probeEmbeddingsEndpoint(
    mimoBase,
    process.env.SANGFOR_MIMO_API_KEY?.trim()
  );
  console.log(JSON.stringify({
    embeddingProvider: embed.name,
    embeddingHealth: embedHealth,
    dimensions: embed.dimensions,
    mimoRerankEnabled: Boolean(mimo),
    mimoRerankHealth: mimoHealth,
    mimoEmbeddingsEndpointAvailable: mimoEmbedProbe,
    allowCloudRag: process.env.SANGFOR_ALLOW_CLOUD_RAG === '1'
  }, null, 2));
  process.exit(embedHealth.ok ? 0 : 1);
}

main();
