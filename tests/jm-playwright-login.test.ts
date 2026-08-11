import { describe, expect, it, vi } from 'vitest';
import { loginWithSessionCredentials } from '../packages/sangfor-jm-execution/src/playwright-driver.js';

describe('JM Playwright local credential login', () => {
  it('fills and submits credentials without exposing them through the port request', async () => {
    const username = {
      count: vi.fn(async () => 1),
      fill: vi.fn(async () => undefined),
    };
    const password = {
      count: vi.fn(async () => 1),
      fill: vi.fn(async () => undefined),
      waitFor: vi.fn(async () => undefined),
      press: vi.fn(async () => undefined),
    };
    const captcha = { count: vi.fn(async () => 0) };
    const submit = {
      count: vi.fn(async () => 1),
      click: vi.fn(async () => undefined),
    };
    const page = {
      locator: vi.fn((selector: string) => {
        if (selector.includes('captcha')) return captcha;
        if (selector.includes('password')) return password;
        if (selector.includes('button')) return submit;
        return username;
      }),
      waitForURL: vi.fn(async () => undefined),
      url: vi.fn(() => 'http://127.0.0.1:3400/hci'),
    };

    await loginWithSessionCredentials(
      page as never,
      { username: 'qa-admin', password: 'qa-secret' },
      'http://127.0.0.1:3400',
    );

    expect(username.fill).toHaveBeenCalledWith('qa-admin');
    expect(password.fill).toHaveBeenCalledWith('qa-secret');
    expect(submit.click).toHaveBeenCalledOnce();
  });
});
