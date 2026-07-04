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
// recursive) and blank every occurrence of them in `text`. 4자 미만 값은 스크럽하지
// 않는다 — 실자격증명이 아닐 가능성이 높고, 과잉 치환이 무관한 텍스트를 오염시킨다
// (키 기반 마스킹은 여전히 적용됨).
export function scrubSecretValues(text: string, source: unknown): string {
  const secrets: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY_RE.test(k) && typeof v === 'string' && v.length >= 4) secrets.push(v);
        else collect(v);
      }
    }
  };
  collect(source);
  secrets.sort((a, b) => b.length - a.length); // 짧은 값이 긴 값을 파편화('***defg')하지 않게
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('***');
  return out;
}
