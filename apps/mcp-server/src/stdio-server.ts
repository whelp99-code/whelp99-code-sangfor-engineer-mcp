import readline from 'node:readline';
import { configureJmBrowserRuntime, disposeJmBrowserRuntime, isJmBrowserRuntimeConfigured } from './browser-runtime-composition.js';
import { createDefaultJmBrowserRuntime } from './jm-browser-runtime.js';
import { createRemoteBrowserExecutionPortFromEnv } from './remote-browser-runtime.js';
import { handle, type JsonRpcRequest } from './mcp-runtime.js';

export function startStdioServer() {
  if (!isJmBrowserRuntimeConfigured()) {
    const localRuntime = createDefaultJmBrowserRuntime();
    const remoteExecutionPort = createRemoteBrowserExecutionPortFromEnv();
    configureJmBrowserRuntime({
      ...localRuntime,
      executionPort: remoteExecutionPort ?? localRuntime.executionPort,
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
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      // Malformed JSON must not crash the stdio server — emit a JSON-RPC parse error.
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
