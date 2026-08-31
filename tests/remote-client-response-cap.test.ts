import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  REMOTE_RESPONSE_BODY_MAX_BYTES,
  collectRemoteResponseBody,
} from '../packages/sangfor-browser-contracts/src/remote-response.js';

describe('remote client response cap', () => {
  it('accepts a response at the exact byte limit', async () => {
    const body = Buffer.alloc(REMOTE_RESPONSE_BODY_MAX_BYTES, 0x61);

    await expect(collectRemoteResponseBody(Readable.from([body]))).resolves.toHaveLength(
      REMOTE_RESPONSE_BODY_MAX_BYTES,
    );
  });

  it('rejects a response one byte beyond the limit', async () => {
    const body = Buffer.alloc(REMOTE_RESPONSE_BODY_MAX_BYTES + 1, 0x61);

    await expect(collectRemoteResponseBody(Readable.from([body]))).rejects.toMatchObject({
      code: 'REMOTE_RESPONSE_BODY_TOO_LARGE',
    });
  });

  it('enforces the cumulative limit across chunks', async () => {
    const first = Buffer.alloc(REMOTE_RESPONSE_BODY_MAX_BYTES, 0x61);

    await expect(collectRemoteResponseBody(Readable.from([first, Buffer.from('b')]))).rejects
      .toMatchObject({ code: 'REMOTE_RESPONSE_BODY_TOO_LARGE' });
  });
});
