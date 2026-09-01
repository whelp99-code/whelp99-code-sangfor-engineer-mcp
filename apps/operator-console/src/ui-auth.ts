export const API_TOKEN_STORAGE_KEY = 'sangfor_api_token';

export function buildApiHeaders(token?: string | null, headers: Record<string, string> = {}): Record<string, string> {
  const out = { ...headers };
  const trimmed = String(token ?? '').trim();
  if (trimmed) out.authorization = `Bearer ${trimmed}`;
  return out;
}
