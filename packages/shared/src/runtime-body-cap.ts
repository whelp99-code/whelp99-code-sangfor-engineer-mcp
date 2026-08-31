import type { Readable } from 'node:stream';

/**
 * Ceiling for a single inbound HTTP request body, shared by every server that
 * reads one. It matches the byte ceiling the strict JSON boundary already
 * enforces, so a body that could never be parsed is refused before it is held
 * in memory rather than after.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  readonly name = 'RequestBodyTooLargeError';

  constructor(readonly limitBytes: number, readonly observedBytes: number) {
    super(`REQUEST_BODY_TOO_LARGE: stopped at ${String(observedBytes)} bytes (limit ${String(limitBytes)})`);
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  throw new TypeError('REQUEST_BODY_CHUNK_INVALID: request stream yielded neither bytes nor text');
}

/**
 * Reads a request body as UTF-8 text, refusing it the moment the bytes seen so
 * far pass `limitBytes`. The running total is checked per arriving chunk and
 * the crossing chunk is never retained, so peak memory stays under the limit
 * no matter how much the client intends to send — the whole point being to
 * refuse before buffering rather than measure a body already in memory.
 *
 * `destroyOnReturn: false` matters: leaving the loop early must release the
 * stream WITHOUT destroying it, because destroying an `IncomingMessage` resets
 * the socket and the caller still has to write a 413 onto it.
 */
export async function readCappedRequestBody(request: Readable, limitBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let observedBytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = toBuffer(chunk);
    observedBytes += buffer.byteLength;
    if (observedBytes > limitBytes) throw new RequestBodyTooLargeError(limitBytes, observedBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
