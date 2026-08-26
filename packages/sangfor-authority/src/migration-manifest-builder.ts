export type MigrationSource = {
  readonly path: string;
  readonly symbol: string;
};

export class StaticInventoryReferenceError extends Error {
  readonly name = 'StaticInventoryReferenceError';

  constructor(readonly reference: string) {
    super(`STATIC_INVENTORY_REFERENCE_INVALID: ${reference}`);
  }
}

export function sourcesFor(refs: readonly string[]): MigrationSource[] {
  return refs.map((reference) => {
    if (reference.startsWith('prisma:model:')) {
      return {
        path: 'prisma/schema.prisma',
        symbol: reference.slice('prisma:model:'.length),
      };
    }
    const match = /^(?:persist|credential):(.+)#([^#]+)$/u.exec(reference);
    const path = match?.[1];
    const symbol = match?.[2];
    if (!path || !symbol) throw new StaticInventoryReferenceError(reference);
    return { path, symbol };
  });
}
