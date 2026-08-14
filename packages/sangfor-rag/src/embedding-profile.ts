export type EmbeddingRole = 'query' | 'document';

export interface EmbeddingProfile {
  model: string;
  dimensions?: number;
  maxTokens?: number;
  requiresRolePrefix: boolean;
  queryPrefix: string;
  documentPrefix: string;
}

export function resolveEmbeddingProfile(model: string, dimensions?: number): EmbeddingProfile {
  const normalized = model.toLowerCase();
  const isE5 = normalized.includes('/e5-') || normalized.includes('multilingual-e5') || normalized.includes('intfloat/e5');
  return {
    model,
    dimensions,
    maxTokens: isE5 ? 512 : undefined,
    requiresRolePrefix: isE5,
    queryPrefix: isE5 ? 'query: ' : '',
    documentPrefix: isE5 ? 'passage: ' : ''
  };
}

export function formatEmbeddingInput(text: string, profile: EmbeddingProfile, role: EmbeddingRole): string {
  const prefix = role === 'query' ? profile.queryPrefix : profile.documentPrefix;
  if (!profile.requiresRolePrefix || text.startsWith(prefix)) return text;
  return `${prefix}${text}`;
}

export function formatEmbeddingBatch(texts: readonly string[], profile: EmbeddingProfile, role: EmbeddingRole): string[] {
  return texts.map((text) => formatEmbeddingInput(text, profile, role));
}
