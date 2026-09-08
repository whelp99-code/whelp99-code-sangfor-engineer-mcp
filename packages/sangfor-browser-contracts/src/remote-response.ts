export const REMOTE_RESPONSE_BODY_MAX_BYTES = 64 * 1024;

export class RemoteResponseBodyTooLargeError extends Error {
  override readonly name = 'RemoteResponseBodyTooLargeError';
  readonly code = 'REMOTE_RESPONSE_BODY_TOO_LARGE';
}

type ResponseStream = NodeJS.ReadableStream & {
  destroy(error?: Error): void;
};

export function collectRemoteResponseBody(stream: ResponseStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    stream.on('data', (value: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (chunk.length > REMOTE_RESPONSE_BODY_MAX_BYTES - receivedBytes) {
        settled = true;
        reject(new RemoteResponseBodyTooLargeError());
        stream.destroy();
        return;
      }
      receivedBytes += chunk.length;
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, receivedBytes).toString('utf8'));
    });
    stream.on('error', (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
