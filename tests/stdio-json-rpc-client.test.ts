import { describe, expect, it } from 'vitest';
import {
  StdioJsonRpcClient,
  type ProcessSignal,
  type ScheduledTask,
  type StdioClientScheduler,
  type StdioProcess,
} from './helpers/stdio-json-rpc-client.js';

type Task = { readonly callback: () => void; cancelled: boolean };

class FakeScheduler implements StdioClientScheduler {
  private readonly tasks: Task[] = [];

  schedule(_delayMs: number, callback: () => void): ScheduledTask {
    const task = { callback, cancelled: false };
    this.tasks.push(task);
    return { cancel: () => { task.cancelled = true; } };
  }

  runNext(): void {
    const task = this.tasks.shift();
    if (task === undefined) throw new TypeError('FAKE_SCHEDULER_EMPTY');
    if (task.cancelled) return this.runNext();
    task.callback();
  }
}

class FakeStdioProcess implements StdioProcess {
  readonly writes: string[] = [];
  readonly signals: ProcessSignal[] = [];
  inputEnded = false;
  closeOnSigkill = false;
  private readonly stdoutListeners: Array<(chunk: string) => void> = [];
  private readonly stderrListeners: Array<(chunk: string) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly closeListeners: Array<() => void> = [];

  write(line: string): void { this.writes.push(line); }
  endInput(): void { this.inputEnded = true; }
  kill(signal: ProcessSignal): void {
    this.signals.push(signal);
    if (signal === 'SIGKILL' && this.closeOnSigkill) this.emitClose();
  }
  onStdout(listener: (chunk: string) => void): void { this.stdoutListeners.push(listener); }
  onStderr(listener: (chunk: string) => void): void { this.stderrListeners.push(listener); }
  onError(listener: (error: Error) => void): void { this.errorListeners.push(listener); }
  onExit(listener: (code: number | null, signal: string | null) => void): void { this.exitListeners.push(listener); }
  onClose(listener: () => void): void { this.closeListeners.push(listener); }
  emitStdout(chunk: string): void { this.stdoutListeners.forEach((listener) => listener(chunk)); }
  emitClose(): void { this.closeListeners.forEach((listener) => listener()); }
}

function setup() {
  const process = new FakeStdioProcess();
  const scheduler = new FakeScheduler();
  const client = new StdioJsonRpcClient({
    process, scheduler, responseTimeoutMs: 100,
    terminationTimeoutMs: 100, killTimeoutMs: 100,
  });
  return { process, scheduler, client };
}

function response(id: string | number): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } })}\n`;
}

async function closeAfter(client: StdioJsonRpcClient, process: FakeStdioProcess): Promise<void> {
  const closing = client.close();
  process.emitClose();
  await closing;
}

describe('StdioJsonRpcClient protocol and lifecycle', () => {
  it('Given malformed JSON, When the child closes, Then close surfaces the framing failure', async () => {
    const fixture = setup();
    fixture.process.emitStdout('{bad-json\n');

    const closing = fixture.client.close();
    fixture.process.emitClose();

    await expect(closing).rejects.toThrow();
  });

  it('Given non-JSON stdout noise, When the child closes, Then close surfaces the protocol failure', async () => {
    const fixture = setup();
    fixture.process.emitStdout('unexpected console noise\n');

    const closing = fixture.client.close();
    fixture.process.emitClose();

    await expect(closing).rejects.toThrow();
  });

  it('Given a truncated frame, When EOF closes the child, Then close refuses the partial frame', async () => {
    const fixture = setup();
    fixture.process.emitStdout('{"jsonrpc":"2.0"');

    const closing = fixture.client.close();
    fixture.process.emitClose();

    await expect(closing).rejects.toThrow('MCP_STDIO_TRUNCATED_FRAME');
  });

  it('Given one correlated response, When its ID arrives again, Then close reports a duplicate response', async () => {
    const fixture = setup();
    const expected = fixture.client.request('same', 'tools/call', {});
    fixture.process.emitStdout(response('same'));
    await expected;

    fixture.process.emitStdout(response('same'));
    const closing = fixture.client.close();
    fixture.process.emitClose();

    await expect(closing).rejects.toThrow('MCP_STDIO_DUPLICATE_RESPONSE_ID:same');
  });

  it('Given no matching request, When an unknown response ID arrives, Then close reports the unexpected ID', async () => {
    const fixture = setup();
    fixture.process.emitStdout(response('unknown'));

    const closing = fixture.client.close();
    fixture.process.emitClose();

    await expect(closing).rejects.toThrow('MCP_STDIO_UNEXPECTED_ID:unknown');
  });

  it('Given an outstanding ID, When the caller reuses it, Then the duplicate rejects before a second write', async () => {
    const fixture = setup();
    const first = fixture.client.request(7, 'tools/call', {});

    await expect(fixture.client.request(7, 'tools/call', {})).rejects.toThrow('MCP_STDIO_DUPLICATE_REQUEST_ID:7');
    fixture.process.emitStdout(response(7));
    await first;
    await closeAfter(fixture.client, fixture.process);

    expect(fixture.process.writes).toHaveLength(1);
  });

  it('Given an expected response already resolved, When late noise arrives, Then close still surfaces it', async () => {
    const fixture = setup();
    const expected = fixture.client.request('done', 'tools/call', {});
    fixture.process.emitStdout(response('done'));
    await expected;

    const closing = fixture.client.close();
    fixture.process.emitStdout('late-noise\n');
    fixture.process.emitClose();

    await expect(closing).rejects.toThrow();
  });

  it('Given SIGTERM is ignored, When the first bound expires, Then SIGKILL closes the child cleanly', async () => {
    const fixture = setup();
    fixture.process.closeOnSigkill = true;
    const closing = fixture.client.close();

    fixture.scheduler.runNext();
    await closing;

    expect(fixture.process.inputEnded).toBe(true);
    expect(fixture.process.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('Given the child ignores SIGTERM and SIGKILL, When both bounds expire, Then close rejects deterministically', async () => {
    const fixture = setup();
    const closing = fixture.client.close();

    fixture.scheduler.runNext();
    fixture.scheduler.runNext();

    await expect(closing).rejects.toThrow('MCP_STDIO_CLOSE_TIMEOUT');
    expect(fixture.process.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
