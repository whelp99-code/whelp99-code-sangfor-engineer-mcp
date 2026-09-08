export type RepositoryCensus = {
  readonly references: readonly string[];
  readonly counts: {
    readonly prismaModels: number;
    readonly persistenceSymbols: number;
    readonly credentialBoundaries: number;
  };
  readonly digest: string;
};

export type CensusContext = {
  readonly repoRoot: string;
  readonly references: ReadonlySet<string>;
  readonly credentialReferences: ReadonlySet<string>;
  readonly sourceSymbols: ReadonlySet<string>;
  readonly packageNames: ReadonlySet<string>;
  readonly targetTables: ReadonlySet<string>;
  readonly projectScopedTables: ReadonlySet<string>;
  readonly rlsTables: ReadonlySet<string>;
};

const contexts = new WeakMap<object, CensusContext>();

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  Object.freeze(value);
}

export function registerCanonicalCensus(
  census: RepositoryCensus,
  context: CensusContext,
): RepositoryCensus {
  deepFreeze(census);
  contexts.set(census, context);
  return census;
}

export function isCanonicalCensus(input: unknown): input is RepositoryCensus {
  return typeof input === 'object' && input !== null && contexts.has(input);
}

export function canonicalCensusContext(input: RepositoryCensus): CensusContext | null {
  return contexts.get(input) ?? null;
}
