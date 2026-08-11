import { describe, expect, it } from 'vitest';
import { maskBrowserObservationText } from '../packages/sangfor-jm-execution/src/playwright-driver.js';

describe('JM browser observation masking', () => {
  it('masks embedded credentials, bearer tokens, and secret-like fields', () => {
    const output = maskBrowserObservationText(
      'user=qa-admin password=qa-secret token: abcdefgh Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      ['qa-admin', 'qa-secret'],
    );

    expect(output).not.toContain('qa-admin');
    expect(output).not.toContain('qa-secret');
    expect(output).not.toContain('abcdefgh');
    expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(output).toContain('password=***');
    expect(output).toContain('Bearer ***');
  });

  it('masks short local credential values exactly', () => {
    const output = maskBrowserObservationText(
      'Welcome adm; entered pw',
      ['adm', 'pw'],
    );

    expect(output).toBe('Welcome ***; entered ***');
  });
});
