import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, paginate } from '../packages/shared/src/index.js';

describe('shared — encodeCursor/decodeCursor (base64url opaque cursor)', () => {
  it('round-trips a key through encode then decode', () => {
    const cursor = encodeCursor('item_42');
    expect(decodeCursor(cursor)).toBe('item_42');
  });

  it('passes undefined through unchanged (first page — no cursor supplied)', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it('rejects a cursor containing characters outside the base64url alphabet', () => {
    expect(() => decodeCursor('not a cursor!')).toThrow('INVALID_CURSOR');
  });

  it('rejects an empty-string cursor', () => {
    expect(() => decodeCursor('')).toThrow('INVALID_CURSOR');
  });
});

describe('shared — paginate<T>', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `id_${i}`, value: i }));

  it('returns the first page with a nextCursor when more items remain', () => {
    const page = paginate(items, { limit: 2, getKey: (i) => i.id });
    expect(page.items.map((i) => i.id)).toEqual(['id_0', 'id_1']);
    expect(page.nextCursor).toBeDefined();
  });

  it('resumes from nextCursor and eventually terminates with no nextCursor', () => {
    const first = paginate(items, { limit: 2, getKey: (i) => i.id });
    const second = paginate(items, { limit: 2, cursor: first.nextCursor, getKey: (i) => i.id });
    expect(second.items.map((i) => i.id)).toEqual(['id_2', 'id_3']);
    expect(second.nextCursor).toBeDefined();

    const third = paginate(items, { limit: 2, cursor: second.nextCursor, getKey: (i) => i.id });
    expect(third.items.map((i) => i.id)).toEqual(['id_4']);
    expect(third.nextCursor).toBeUndefined();
  });

  it('applies defaultLimit when limit is omitted', () => {
    const page = paginate(items, { defaultLimit: 3, getKey: (i) => i.id });
    expect(page.items).toHaveLength(3);
  });

  it('rejects a cursor that does not identify a row in the current result set', () => {
    expect(() => paginate(items, { cursor: encodeCursor('does_not_exist'), getKey: (i) => i.id }))
      .toThrow('INVALID_CURSOR');
  });

  it('rejects an out-of-range limit', () => {
    expect(() => paginate(items, { limit: 0, getKey: (i) => i.id })).toThrow('INVALID_INPUT');
    expect(() => paginate(items, { limit: 101, getKey: (i) => i.id })).toThrow('INVALID_INPUT');
    expect(() => paginate(items, { limit: 1.5, getKey: (i) => i.id })).toThrow('INVALID_INPUT');
  });

  it('honors a caller-supplied maxLimit', () => {
    expect(() => paginate(items, { limit: 10, maxLimit: 5, getKey: (i) => i.id })).toThrow('INVALID_INPUT');
  });

  it('returns an empty page with no nextCursor for an empty input array', () => {
    const page = paginate([], { getKey: (i: { id: string }) => i.id });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });
});
