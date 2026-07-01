import { describe, expect, it } from 'vitest';
import { buildApiHeaders } from '../apps/operator-console/src/ui.js';

describe('operator console API auth headers', () => {
  it('adds Authorization bearer header when a dashboard token is stored', () => {
    expect(buildApiHeaders('secret-token', { 'content-type': 'application/json' })).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer secret-token',
    });
  });
});
