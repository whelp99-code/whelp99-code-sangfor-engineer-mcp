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
});
