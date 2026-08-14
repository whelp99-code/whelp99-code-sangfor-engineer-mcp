import {
  getEmbeddingProvider,
  resetEmbeddingProviderCache,
  resolveEmbeddingModelFromEnv,
  resolveEmbeddingProfile,
  wasEmbeddingFallback
} from '../packages/sangfor-rag/src/embedding-provider.js';

async function main(): Promise<void> {
  resetEmbeddingProviderCache();
  const provider = await getEmbeddingProvider();
  const model = 'model' in provider && typeof provider.model === 'string'
    ? provider.model
    : resolveEmbeddingModelFromEnv();
  const profile = resolveEmbeddingProfile(model, provider.dimensions);
  const health = await provider.healthCheck();

  console.log(JSON.stringify({
    schemaVersion: 1,
    backend: provider.name,
    providerDimensions: provider.dimensions,
    requestedModel: resolveEmbeddingModelFromEnv(),
    servedModel: model,
    wasFallback: wasEmbeddingFallback() || provider.name === 'hash',
    health,
    profile
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
