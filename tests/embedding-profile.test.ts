import { describe, expect, it } from 'vitest';
import { formatEmbeddingInput, resolveEmbeddingProfile } from '../packages/sangfor-rag/src/embedding-profile.js';

describe('embedding profile role formatting', () => {
  it('adds E5 query and passage prefixes exactly once', () => {
    const profile = resolveEmbeddingProfile('intfloat/multilingual-e5-small', 384);

    expect(profile.requiresRolePrefix).toBe(true);
    expect(profile.maxTokens).toBe(512);
    expect(formatEmbeddingInput('storage heartbeat', profile, 'query')).toBe('query: storage heartbeat');
    expect(formatEmbeddingInput('storage heartbeat', profile, 'document')).toBe('passage: storage heartbeat');
    expect(formatEmbeddingInput('query: storage heartbeat', profile, 'query')).toBe('query: storage heartbeat');
  });

  it('leaves non-E5 models unchanged', () => {
    const profile = resolveEmbeddingProfile('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2', 384);
    expect(formatEmbeddingInput('storage heartbeat', profile, 'query')).toBe('storage heartbeat');
  });
});
