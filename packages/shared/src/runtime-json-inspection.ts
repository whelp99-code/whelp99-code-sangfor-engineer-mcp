export type JsonInspectionIssue = {
  readonly code:
    | 'prototype_key'
    | 'max_depth_exceeded'
    | 'max_nodes_exceeded'
    | 'max_array_length_exceeded'
    | 'max_object_keys_exceeded';
  readonly path: readonly (string | number)[];
};

export type JsonInspectionLimits = {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
};

type TraversalNode = {
  readonly value: unknown;
  readonly depth: number;
  readonly path: readonly (string | number)[];
};

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function inspectJsonTree(
  value: unknown,
  limits: JsonInspectionLimits,
): JsonInspectionIssue | undefined {
  const pending: TraversalNode[] = [{ value, depth: 0, path: [] }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > limits.maxNodes) return { code: 'max_nodes_exceeded', path: [] };
    if (current.depth > limits.maxDepth) return { code: 'max_depth_exceeded', path: [] };

    if (Array.isArray(current.value)) {
      if (current.value.length > limits.maxArrayLength) {
        return { code: 'max_array_length_exceeded', path: current.path };
      }
      for (const [index, child] of current.value.entries()) {
        pending.push({ value: child, depth: current.depth + 1, path: [...current.path, index] });
      }
      continue;
    }
    if (!isJsonRecord(current.value)) continue;
    const entries = Object.entries(current.value);
    if (entries.length > limits.maxObjectKeys) {
      return { code: 'max_object_keys_exceeded', path: current.path };
    }
    for (const [key, child] of entries) {
      if (PROTOTYPE_KEYS.has(key)) return { code: 'prototype_key', path: [...current.path, key] };
      pending.push({ value: child, depth: current.depth + 1, path: [...current.path, key] });
    }
  }
  return undefined;
}

export function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isJsonRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function duplicateValueIssue(
  value: unknown,
  collectionPath: readonly string[],
  key: string,
): { readonly code: 'duplicate_id'; readonly path: readonly (string | number)[] } | undefined {
  const collection = valueAtPath(value, collectionPath);
  if (!Array.isArray(collection)) return undefined;
  const values = new Set<string | number>();
  for (const [index, item] of collection.entries()) {
    if (!isJsonRecord(item)) continue;
    const candidate = item[key];
    if (typeof candidate !== 'string' && typeof candidate !== 'number') continue;
    if (values.has(candidate)) return { code: 'duplicate_id', path: [...collectionPath, index, key] };
    values.add(candidate);
  }
  return undefined;
}
