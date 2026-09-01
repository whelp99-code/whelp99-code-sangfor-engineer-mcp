const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/u;

export function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (!CURSOR_RE.test(cursor)) throw new Error('INVALID_CURSOR: cursor is malformed.');
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

export interface PaginateOptions<T> {
  cursor?: string;
  limit?: number;
  defaultLimit?: number;
  maxLimit?: number;
  getKey: (item: T) => string;
}

export interface PaginateResult<T> {
  items: T[];
  nextCursor?: string;
}

export function paginate<T>(items: readonly T[], opts: PaginateOptions<T>): PaginateResult<T> {
  const limit = opts.limit ?? opts.defaultLimit ?? 50;
  const maxLimit = opts.maxLimit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new Error(`INVALID_INPUT: limit must be 1..${maxLimit}.`);
  }
  const after = decodeCursor(opts.cursor);
  const start = after === undefined ? 0 : items.findIndex((item) => opts.getKey(item) === after) + 1;
  if (after !== undefined && start === 0) {
    throw new Error('INVALID_CURSOR: cursor does not identify the current result set.');
  }
  const page = items.slice(start, start + limit);
  const last = page.at(-1);
  return start + page.length < items.length && last
    ? { items: page, nextCursor: encodeCursor(opts.getKey(last)) }
    : { items: page };
}
