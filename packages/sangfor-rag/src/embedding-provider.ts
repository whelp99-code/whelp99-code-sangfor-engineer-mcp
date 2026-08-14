/**
 * Embedding provider chain — docs/design/RAG_SEMANTIC_EMBEDDINGS.md
 */
import { HashEmbeddingProvider } from './hash-embedding.js';
import { createLitellmWithFallback } from './litellm-provider.js';
import { createRapidMlxWithFallback } from './rapid-mlx-provider.js';
import { formatEmbeddingBatch, resolveEmbeddingProfile, type EmbeddingRole } from './embedding-profile.js';
import type { EmbeddingProvider } from './embedding-provider-types.js';

export type { EmbeddingBackend, EmbeddingProvider, RerankProvider } from './embedding-provider-types.js';

export { HashEmbeddingProvider } from './hash-embedding.js';
export { formatEmbeddingInput, resolveEmbeddingProfile, type EmbeddingProfile, type EmbeddingRole } from './embedding-profile.js';

export function resolveEmbeddingBackendFromEnv(): import('./embedding-provider-types.js').EmbeddingBackend {
  const raw = (process.env.SANGFOR_EMBEDDING_PROVIDER ?? 'rapid-mlx').trim().toLowerCase();
  if (raw === 'mimo' || raw === 'hash' || raw === 'litellm') return raw;
  return 'rapid-mlx';
}

export function resolveEmbeddingModelFromEnv(): string {
  if (resolveEmbeddingBackendFromEnv() === 'litellm') {
    return process.env.SANGFOR_LITELLM_EMBEDDING_MODEL?.trim()
      || process.env.SANGFOR_RAPID_MLX_EMBEDDING_MODEL?.trim()
      || 'text-embedding-3-small';
  }
  return process.env.SANGFOR_RAPID_MLX_EMBEDDING_MODEL?.trim()
    || 'mlx-community/nomic-embed-text-v1.5-4bit';
}

let cachedProvider: import('./embedding-provider-types.js').EmbeddingProvider | undefined;
let fallbackResolvedAt = 0;

// Whether the provider currently cached is a hash fallback the caller did NOT
// explicitly request (as opposed to hash being the deliberate configuration).
// exportRagIndexSummary/ragSearch use this to report degraded retrieval
// honestly instead of silently ranking on hashed bag-of-words while claiming
// a semantic model was used.
let lastResolutionWasFallback = false;
const fallbackWarned = new Set<string>();

function warnHashFallback(requested: string): void {
  lastResolutionWasFallback = true;
  fallbackResolvedAt = Date.now();
  if (fallbackWarned.has(requested)) return;
  fallbackWarned.add(requested);
  process.stderr.write(`[rag] embedding provider '${requested}' unavailable — falling back to hash\n`);
}

export function wasEmbeddingFallback(): boolean {
  return lastResolutionWasFallback;
}

function resolveFailbackRetryMs(): number {
  const raw = Number(process.env.SANGFOR_EMBEDDING_FAILBACK_RETRY_MS ?? '30000');
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

function shouldRetryFailback(requested: import('./embedding-provider-types.js').EmbeddingBackend): boolean {
  return Boolean(
    cachedProvider
    && cachedProvider.name === 'hash'
    && lastResolutionWasFallback
    && requested !== 'hash'
    && Date.now() - fallbackResolvedAt >= resolveFailbackRetryMs()
  );
}

async function resolveRequestedProvider(
  requested: import('./embedding-provider-types.js').EmbeddingBackend,
  timeoutMs: number
): Promise<import('./embedding-provider-types.js').EmbeddingProvider | undefined> {
  const init = requested === 'litellm'
    ? createLitellmWithFallback()
    : createRapidMlxWithFallback();
  return await Promise.race([
    init,
    new Promise<undefined>((_, reject) => setTimeout(() => reject(new Error('init-timeout')), timeoutMs))
  ]);
}

export async function getEmbeddingProvider(): Promise<import('./embedding-provider-types.js').EmbeddingProvider> {
  if (process.env.SANGFOR_EMBEDDING_FORCE_HASH === '1') {
    lastResolutionWasFallback = false;
    if (!cachedProvider || cachedProvider.name !== 'hash') cachedProvider = new HashEmbeddingProvider();
    return cachedProvider;
  }
  const requested = resolveEmbeddingBackendFromEnv();
  if (requested === 'hash') {
    lastResolutionWasFallback = false;
    if (!cachedProvider || cachedProvider.name !== 'hash') cachedProvider = new HashEmbeddingProvider();
    return cachedProvider;
  }
  const timeoutMs = Number(process.env.SANGFOR_EMBEDDING_INIT_TIMEOUT_MS ?? '5000');
  if (cachedProvider && !shouldRetryFailback(requested)) return cachedProvider;

  try {
    const result = await resolveRequestedProvider(requested, timeoutMs);
    if (result) {
      cachedProvider = result;
      // Provider factories can themselves already resolve to a hash provider
      // (their own internal health-check fallback) — treat that the same as
      // our own timeout/exception fallback below.
      if (result.name === 'hash') warnHashFallback(requested); else lastResolutionWasFallback = false;
      return cachedProvider;
    }
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    // Fall through to hash
  }
  warnHashFallback(requested);
  cachedProvider = new HashEmbeddingProvider();
  return cachedProvider;
}

export function resetEmbeddingProviderCache(): void {
  cachedProvider = undefined;
  lastResolutionWasFallback = false;
  fallbackResolvedAt = 0;
  fallbackWarned.clear();
}

export function createEmbeddingProviderFromEnv(): HashEmbeddingProvider {
  return new HashEmbeddingProvider();
}

export async function embedForRole(provider: EmbeddingProvider, texts: readonly string[], role: EmbeddingRole): Promise<number[][]> {
  const model = 'model' in provider && typeof provider.model === 'string'
    ? provider.model
    : resolveEmbeddingModelFromEnv();
  const profile = resolveEmbeddingProfile(model, provider.dimensions);
  return provider.embed(formatEmbeddingBatch(texts, profile, role));
}
