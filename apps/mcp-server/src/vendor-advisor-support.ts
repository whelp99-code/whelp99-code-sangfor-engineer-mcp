export function apiBaseUrl(host: string): string {
  return /^https?:\/\//i.test(host) ? host.replace(/\/$/, '') : `https://${host}`;
}

// evaluateSpec() takes a flat observedKey->value record; the client mappers
// return provenance-carrying ConfigStateItem[] — flatten one into the other.
export function toObservedRecord(items: Array<{ observedKey: string; value: unknown }>): Record<string, unknown> {
  return Object.fromEntries(items.map((i) => [i.observedKey, i.value]));
}
