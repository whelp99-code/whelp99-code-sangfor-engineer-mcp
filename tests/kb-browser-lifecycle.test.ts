import { describe, expect, it, vi } from 'vitest';
import {
  withKbBrowser,
  type KbBrowserHandle,
  type KbBrowserTokens
} from '../scripts/lib/kb-browser-session.js';

const tokens: KbBrowserTokens = {
  libraryToken: 'library-token',
  tokenByCode: 'token-by-code'
};

function fakeHandle(close: () => Promise<void>): KbBrowserHandle {
  return {
    browser: {} as KbBrowserHandle['browser'],
    context: {} as KbBrowserHandle['context'],
    page: {} as KbBrowserHandle['page'],
    close
  };
}

describe('withKbBrowser', () => {
  it('closes the browser when the operation succeeds', async () => {
    const close = vi.fn(async () => {});
    const launcher = vi.fn(async () => fakeHandle(close));

    await expect(withKbBrowser(tokens, async () => 'ok', launcher)).resolves.toBe('ok');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the browser when the operation fails', async () => {
    const close = vi.fn(async () => {});
    const launcher = vi.fn(async () => fakeHandle(close));

    await expect(
      withKbBrowser(tokens, async () => {
        throw new Error('discovery failed');
      }, launcher)
    ).rejects.toThrow('discovery failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('rethrows the operation error unchanged when close also fails', async () => {
    // Given an operation and a close that both fail with distinct errors.
    const primary = new Error('primary failure');
    const launcher = vi.fn(async () => fakeHandle(async () => {
      throw new Error('close failure');
    }));

    // When the session runs.
    const settled = withKbBrowser(tokens, async () => {
      throw primary;
    }, launcher);

    // Then the caller sees the original operation error, not the close error.
    await expect(settled).rejects.toBe(primary);
  });

  it('attempts close exactly once when both the operation and close fail', async () => {
    // Given an operation and a close that both fail.
    const close = vi.fn(async () => {
      throw new Error('close failure');
    });
    const launcher = vi.fn(async () => fakeHandle(close));

    // When the session runs.
    await withKbBrowser(tokens, async () => {
      throw new Error('primary failure');
    }, launcher).catch(() => undefined);

    // Then cleanup was attempted, and only once.
    expect(close).toHaveBeenCalledOnce();
  });

  it('surfaces the close failure when the operation succeeds', async () => {
    // Given an operation that succeeds and a close that fails.
    const closeFailure = new Error('close failure');
    const launcher = vi.fn(async () => fakeHandle(async () => {
      throw closeFailure;
    }));

    // When the session runs.
    const settled = withKbBrowser(tokens, async () => 'ok', launcher);

    // Then the close failure is not hidden behind a successful result.
    await expect(settled).rejects.toBe(closeFailure);
  });
});
