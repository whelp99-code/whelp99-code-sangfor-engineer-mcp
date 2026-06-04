import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadOneSessionFromEnv } from '../packages/sangfor-collector/src/one-session.js';

describe('one-session env', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.SANGFOR_ONE_ACCESS_TOKEN;
    delete process.env.SANGFOR_KB_TOKEN;
  });

  afterEach(() => {
    process.env = env;
  });

  it('loads ONE and KB tokens from environment', () => {
    process.env.SANGFOR_ONE_ACCESS_TOKEN = 'one-test-token';
    process.env.SANGFOR_KB_TOKEN = 'kb-test-token';
    const cfg = loadOneSessionFromEnv();
    expect(cfg.accessToken).toBe('one-test-token');
    expect(cfg.kbToken).toBe('kb-test-token');
    expect(cfg.oneBaseUrl).toContain('one.sangfor.com');
  });
});
