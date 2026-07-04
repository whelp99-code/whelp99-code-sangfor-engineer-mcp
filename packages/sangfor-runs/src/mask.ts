// Replicated from packages/sangfor-hci-client/src/audit-ledger.ts so run history
// gets the same masking without a domain dependency on the HCI client. Keep the
// regex in sync with the original — tests/sangfor-runs-store.test.ts pins parity.
const SECRET_KEY_RE = /password|secret|token|authorization|cookie/i;

export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) && typeof v === 'string' ? '***' : maskSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}

// Key-based masking cannot scrub secrets already embedded in free text (error
// messages, logs). Collect secret string values from `source` (same key regex,
// recursive) and blank every occurrence of them in `text`.
export function scrubSecretValues(text: string, source: unknown): string {
  const secrets: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY_RE.test(k) && typeof v === 'string' && v.length > 0) secrets.push(v);
        else collect(v);
      }
    }
  };
  collect(source);
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('***');
  return out;
}
