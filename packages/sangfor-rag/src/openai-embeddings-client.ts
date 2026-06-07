export interface OpenAIEmbeddingsOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  authHeader?: 'authorization' | 'api-key';
}

export async function fetchOpenAIEmbeddings(
  texts: string[],
  options: OpenAIEmbeddingsOptions
): Promise<{ vectors: number[][]; model: string }> {
  const base = options.baseUrl.replace(/\/$/, '');
  const url = `${base}/embeddings`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.apiKey) {
    if (options.authHeader === 'api-key') {
      headers['api-key'] = options.apiKey;
    } else {
      headers.authorization = `Bearer ${options.apiKey}`;
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: options.model, input: texts }),
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Embeddings API ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as {
      data?: Array<{ embedding: number[]; index: number }>;
      model?: string;
    };
    const rows = [...(data.data ?? [])].sort((a, b) => a.index - b.index);
    if (rows.length !== texts.length) {
      throw new Error(`Embeddings API returned ${rows.length} vectors for ${texts.length} inputs`);
    }
    return { vectors: rows.map(r => r.embedding), model: data.model ?? options.model };
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeEmbeddingsEndpoint(
  baseUrl: string,
  apiKey?: string,
  authHeader: OpenAIEmbeddingsOptions['authHeader'] = 'api-key'
): Promise<boolean> {
  try {
    await fetchOpenAIEmbeddings(['probe'], {
      baseUrl,
      apiKey,
      model: 'probe',
      timeoutMs: 8_000,
      authHeader
    });
    return true;
  } catch {
    return false;
  }
}
