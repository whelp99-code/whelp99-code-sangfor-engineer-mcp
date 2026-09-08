import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRET = Buffer.alloc(32, 0x42).toString('base64');
export const FUTURE = '2099-01-01T00:00:00.000Z';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function runNonceChild(
  filePath: string,
  sourcePath: string,
  nonce: string,
): Promise<{ code: number | null; output: string }> {
  const script = `import { FileSingleUseNonceStore } from ${JSON.stringify(sourcePath)};
import { explicitLocalPrimaryAuthority } from '@sangfor/shared';
void (async () => {
  const authority = explicitLocalPrimaryAuthority({ tenantId: 'test-tenant', projectId: 'local-primary', actorId: 'test-actor', aggregate: 'approvals_nonces', sourceRoot: ${JSON.stringify(dirname(filePath))} });
  const result = await new FileSingleUseNonceStore(${JSON.stringify(filePath)}, authority).consume(${JSON.stringify(nonce)}, ${JSON.stringify(FUTURE)});
  process.stdout.write(JSON.stringify(result));
})();`;
  const child = spawn(fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url)), ['-e', script], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: process.env,
  });
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}
