import readline from 'node:readline';
import { configureJmBrowserRuntime, disposeJmBrowserRuntime, isJmBrowserRuntimeConfigured } from './browser-runtime-composition.js';
import { createDefaultJmBrowserRuntime } from './jm-browser-runtime.js';
import { createRemoteBrowserExecutionPortFromEnv } from './remote-browser-runtime.js';
import { RuntimeSchemaError } from '../../../packages/shared/src/runtime-schema.js';
import { handle, type JsonRpcRequest } from './mcp-runtime.js';
import { parseBoundaryMcpStdioRequestV1 } from './runtime-boundaries.js';

export function startStdioServer() {
  if (!isJmBrowserRuntimeConfigured()) {
    const localRuntime = createDefaultJmBrowserRuntime();
    const remoteExecutionPort = createRemoteBrowserExecutionPortFromEnv();
    const remoteVerificationPort = remoteExecutionPort === undefined
      ? undefined
      : createRemoteBrowserExecutionPortFromEnv(process.env, 'verification');
    configureJmBrowserRuntime({
      ...localRuntime,
      executionPort: remoteExecutionPort ?? localRuntime.executionPort,
      verificationPort: remoteVerificationPort ?? localRuntime.verificationPort,
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let shutdown: Promise<void> | undefined;
  const disposeBrowserRuntime = () => {
    shutdown ??= disposeJmBrowserRuntime();
    return shutdown;
  };
  const reportShutdownFailure = (error: unknown) => {
    process.exitCode = 1;
    console.error('JM browser runtime shutdown failed:', error);
  };
  rl.once('close', () => {
    void disposeBrowserRuntime().catch(reportShutdownFailure);
  });
  process.once('SIGINT', () => {
    void (async () => {
      process.exitCode = 130;
      rl.close();
      await disposeBrowserRuntime();
    })().catch(reportShutdownFailure);
  });
  process.once('SIGTERM', () => {
    void (async () => {
      process.exitCode = 143;
      rl.close();
      await disposeBrowserRuntime();
    })().catch(reportShutdownFailure);
  });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req: JsonRpcRequest;
    try {
      req = parseBoundaryMcpStdioRequestV1(line);
    } catch (error) {
      if (!(error instanceof RuntimeSchemaError)) throw error;
      // Invalid JSON must not crash the stdio server or dispatch a request.
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    try {
      const res = await handle(req);
      process.stdout.write(`${JSON.stringify(res)}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32603, message: String(err instanceof Error ? err.message : err) } })}\n`);
    }
  });

  process.on('unhandledRejection', (e) => process.stderr.write(`unhandledRejection: ${String(e)}\n`));
  process.on('uncaughtException', (e) => process.stderr.write(`uncaughtException: ${String(e)}\n`));

  process.stderr.write('sangfor-engineer-mcp stdio server started\n');
}
