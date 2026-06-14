/** Local LiteLLM proxy (OpenAI-compatible /v1). */

/** CrewAI uses `openai/local-rapid`; LiteLLM `/v1/models` lists `local-rapid`. */
export function normalizeLitellmModelId(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith('openai/')) return trimmed.slice('openai/'.length);
  return trimmed;
}

export function resolveLitellmBaseUrl(): string {
  const raw = process.env.SANGFOR_LITELLM_BASE_URL?.trim()
    || process.env.LITELLM_BASE_URL?.trim()
    || process.env.OPENAI_API_BASE?.trim()
    || 'http://127.0.0.1:4000/v1';
  return raw.replace(/\/$/, '');
}

export function resolveLitellmApiKey(): string | undefined {
  const key = process.env.SANGFOR_LITELLM_API_KEY?.trim()
    || process.env.LITELLM_MASTER_KEY?.trim()
    || process.env.LITELLM_API_KEY?.trim()
    || process.env.OPENAI_API_KEY?.trim();
  return key || undefined;
}

/** LiteLLM router model for /v1/embeddings (e.g. openai/local-rapid). */
export function resolveLitellmEmbeddingModel(): string {
  const raw = process.env.SANGFOR_LITELLM_EMBEDDING_MODEL?.trim()
    || process.env.SANGFOR_LITELLM_EMBED_MODEL?.trim()
    || 'local-rapid';
  return normalizeLitellmModelId(raw);
}

/** LiteLLM router model for /v1/chat/completions rerank (e.g. cloud-mimo). */
export function resolveLitellmChatModel(): string {
  const raw = process.env.SANGFOR_LITELLM_CHAT_MODEL?.trim()
    || process.env.SANGFOR_MIMO_CHAT_MODEL?.trim()
    || 'cloud-mimo';
  return normalizeLitellmModelId(raw);
}

export function isMimoViaLitellm(): boolean {
  return process.env.SANGFOR_MIMO_VIA_LITELLM === '1'
    || (process.env.SANGFOR_USE_LITELLM_PROXY === '1' && Boolean(resolveLitellmBaseUrl()));
}
