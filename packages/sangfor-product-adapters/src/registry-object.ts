export function isPlainRecord(value: unknown): value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function assertPlainRecord(value: unknown, label: string): asserts value is object {
  if (!isPlainRecord(value)) throw new Error(`INVALID_REGISTRY: ${label} must be a plain object.`);
}

export function hasOwnProperty(value: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    throw new Error('INVALID_REGISTRY: object property inspection failed.');
  }
}

export function readOwnDataProperty(value: object, key: string, label: string): unknown {
  if (!hasOwnProperty(value, key)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`INVALID_REGISTRY: ${label}.${key} must be an own data property.`);
    }
    return descriptor.value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('INVALID_REGISTRY:')) throw error;
    throw new Error(`INVALID_REGISTRY: ${label}.${key} could not be read safely.`);
  }
}

export function ownStringKeys(value: object, label: string): string[] {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new Error(`INVALID_REGISTRY: ${label} keys could not be inspected safely.`);
  }
  if (keys.some((key) => typeof key !== 'string')) {
    throw new Error(`INVALID_REGISTRY: ${label} contains a symbol key.`);
  }
  return keys as string[];
}

export function exactOwnDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  assertPlainRecord(value, label);
  const keys = ownStringKeys(value, label);
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    throw new Error(`INVALID_REGISTRY: ${label} contains missing or unknown keys.`);
  }
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) fields[key] = readOwnDataProperty(value, key, label);
  return fields;
}

export function denseDataArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`INVALID_REGISTRY: ${label} must be an array.`);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype && prototype !== null) {
      throw new Error(`INVALID_REGISTRY: ${label} must have a plain array prototype.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('INVALID_REGISTRY:')) throw error;
    throw new Error(`INVALID_REGISTRY: ${label} could not be inspected safely.`);
  }
  const length = readOwnDataProperty(value, 'length', label);
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new Error(`INVALID_REGISTRY: ${label} has an invalid length.`);
  }
  const keys = ownStringKeys(value, label);
  for (const key of keys) {
    if (key === 'length') continue;
    if (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length) {
      throw new Error(`INVALID_REGISTRY: ${label} must contain dense numeric indices only.`);
    }
  }
  if (keys.length !== length + 1) throw new Error(`INVALID_REGISTRY: ${label} contains a hole.`);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!hasOwnProperty(value, key)) throw new Error(`INVALID_REGISTRY: ${label} contains a hole.`);
    result.push(readOwnDataProperty(value, key, `${label}[${index}]`));
  }
  return result;
}

export function denseStringArray(value: unknown, label: string): string[] {
  const items = denseDataArray(value, label);
  if (items.some((item) => typeof item !== 'string')) {
    throw new Error(`INVALID_REGISTRY: ${label} must contain only strings.`);
  }
  return items as string[];
}

export function assertStrictObjectKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
  const keys = ownStringKeys(value, label);
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new Error(`INVALID_REGISTRY: ${label} contains an unknown key.`);
    }
  }
}

export function strictRegistryDigest(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`INVALID_REGISTRY: ${field} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

export function strictProductVariant(value: unknown, field: string): string | null | undefined {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new Error(`SPEC_IDENTITY_MISMATCH: ${field} must be a string or null.`);
  }
  return value as string | null | undefined;
}
