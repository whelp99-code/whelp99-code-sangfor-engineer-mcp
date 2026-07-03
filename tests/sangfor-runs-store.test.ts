import { describe, expect, it } from 'vitest';
import { maskSecrets } from '@sangfor/runs';
import { maskSecrets as hciMaskSecrets } from '@sangfor/hci-client';

// §4.6 마스킹 계약: /password|secret|token|authorization|cookie/i 키 + string 값 → '***'
describe('maskSecrets — @sangfor/runs 복제본 (T-RUN-2)', () => {
  const fixture = {
    username: 'admin',
    password: 'p@ss',
    nested: {
      apiToken: 'tok123',
      Authorization: 'Bearer x',
      list: [{ cookie: 'c=1', keep: 42 }],
    },
    secretNote: 'text',
    count: 3,
  };

  it('masks matching keys with string values, recursively, arrays included', () => {
    const masked = maskSecrets(fixture) as typeof fixture;
    expect(masked.password).toBe('***');
    expect(masked.nested.apiToken).toBe('***');
    expect(masked.nested.Authorization).toBe('***');
    expect(masked.nested.list[0].cookie).toBe('***');
    expect(masked.secretNote).toBe('***'); // 'secret' substring match
    expect(masked.username).toBe('admin');
    expect(masked.nested.list[0].keep).toBe(42);
    expect(masked.count).toBe(3);
  });

  it('does not mutate the input and leaves non-string secret values untouched', () => {
    const input = { password: 123, meta: { token: true } };
    const masked = maskSecrets(input) as typeof input;
    expect(masked.password).toBe(123);
    expect(masked.meta.token).toBe(true);
    expect(input.password).toBe(123);
  });

  it('behaves identically to the hci-client original (regex 계약 동기화 고정)', () => {
    expect(maskSecrets(fixture)).toEqual(hciMaskSecrets(fixture));
  });
});
