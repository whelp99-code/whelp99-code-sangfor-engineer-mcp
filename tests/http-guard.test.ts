import { afterEach, describe, expect, it } from 'vitest';
import { resolveBindHost, checkAuth, assertBindSafety, isLoopback } from '../packages/shared/src/index.js';

afterEach(() => {
  delete process.env.BIND_HOST;
});

describe('resolveBindHost — loopback by default (no accidental LAN exposure)', () => {
  it('defaults to 127.0.0.1', () => {
    expect(resolveBindHost()).toBe('127.0.0.1');
  });
  it('honors an explicit BIND_HOST opt-in', () => {
    process.env.BIND_HOST = '0.0.0.0';
    expect(resolveBindHost()).toBe('0.0.0.0');
  });
});

describe('isLoopback', () => {
  it('recognizes loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
  });
  it('treats routable addresses as non-loopback', () => {
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('10.0.0.5')).toBe(false);
  });
});

describe('checkAuth — shared-secret Bearer gate', () => {
  it('is open when no token is configured (auth disabled)', () => {
    expect(checkAuth(undefined, undefined).ok).toBe(true);
    expect(checkAuth('Bearer whatever', undefined).ok).toBe(true);
  });
  it('accepts the correct Bearer token', () => {
    expect(checkAuth('Bearer s3cret', 's3cret').ok).toBe(true);
  });
  it('rejects a missing or wrong token with 401', () => {
    expect(checkAuth(undefined, 's3cret')).toEqual({ ok: false, status: 401 });
    expect(checkAuth('Bearer nope', 's3cret')).toEqual({ ok: false, status: 401 });
    expect(checkAuth('s3cret', 's3cret')).toEqual({ ok: false, status: 401 }); // missing "Bearer " prefix
  });
});

describe('assertBindSafety — fail-closed on non-loopback without a token', () => {
  it('allows loopback without a token', () => {
    expect(() => assertBindSafety('127.0.0.1', undefined)).not.toThrow();
  });
  it('refuses to start on a non-loopback bind with no token', () => {
    expect(() => assertBindSafety('0.0.0.0', undefined)).toThrow(/token|loopback|SANGFOR_API_TOKEN/i);
  });
  it('allows a non-loopback bind when a token is set', () => {
    expect(() => assertBindSafety('0.0.0.0', 'a-strong-token')).not.toThrow();
  });
});
