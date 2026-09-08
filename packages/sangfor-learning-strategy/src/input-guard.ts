const SECRET_FIELD = /^(?:username|password|token|cookie|authorization|secret|apiKey)$/iu;

/**
 * The single boundary every untrusted learning request crosses: credential-shaped
 * keys, unknown top-level fields, and cyclic graphs are refused before any value
 * reaches the interior. `path` and `seen` are the recursion cursors of the exported
 * signature that `apps/mcp-server` and the strategy service already depend on.
 */
export function assertSafeLearningInput(value: unknown, allowedKeys?: readonly string[], path = '$', seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`INVALID_INPUT: ${path} must be an object.`);
  if (seen.has(value as object)) throw new Error('INVALID_INPUT: cyclic input is forbidden.');
  seen.add(value as object);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(key)) throw new Error(`SECRET_FIELD_FORBIDDEN: ${path}.${key}`);
    if (allowedKeys && !allowedKeys.includes(key)) throw new Error(`UNKNOWN_FIELD: ${path}.${key}`);
    if (child && typeof child === 'object') {
      if (Array.isArray(child)) {
        for (const [index, item] of child.entries()) {
          if (item && typeof item === 'object') assertSafeLearningInput(item, undefined, `${path}.${key}[${index}]`, seen);
        }
      } else assertSafeLearningInput(child, undefined, `${path}.${key}`, seen);
    }
  }
  seen.delete(value as object);
}
