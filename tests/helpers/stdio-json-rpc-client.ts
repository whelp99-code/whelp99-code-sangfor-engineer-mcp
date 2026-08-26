import { z } from 'zod';

export type JsonRpcId = string | number;
export type ProcessSignal = 'SIGTERM' | 'SIGKILL';

export interface StdioProcess {
  write(line: string): void;
  endInput(): void;
  kill(signal: ProcessSignal): void;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onClose(listener: () => void): void;
}

export interface ScheduledTask {
  cancel(): void;
}

export interface StdioClientScheduler {
  schedule(delayMs: number, callback: () => void): ScheduledTask;
}

export const systemStdioClientScheduler: StdioClientScheduler = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
};

const responseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).passthrough().optional(),
}).passthrough().refine((value) => (value.result !== undefined) !== (value.error !== undefined));

type PendingResponse = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timeout: ScheduledTask;
};

type CloseWaiter = {
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
};

export class StdioJsonRpcClient {
  private readonly pending = new Map<JsonRpcId, PendingResponse>();
  private readonly issuedIds = new Set<JsonRpcId>();
  private readonly completedIds = new Set<JsonRpcId>();
  private stdoutBuffer = '';
  private stderr = '';
  private protocolFailure: Error | undefined;
  private closing = false;
  private closed = false;
  private closeWaiter: CloseWaiter | undefined;
  private closePromise: Promise<void> | undefined;
  private terminationTask: ScheduledTask | undefined;
  private killTask: ScheduledTask | undefined;

  constructor(private readonly options: {
    readonly process: StdioProcess;
    readonly scheduler?: StdioClientScheduler;
    readonly responseTimeoutMs?: number;
    readonly terminationTimeoutMs?: number;
    readonly killTimeoutMs?: number;
    readonly readyMarker?: string;
  }) {
    options.process.onStdout((chunk) => this.onStdout(chunk));
    options.process.onStderr((chunk) => { this.stderr += chunk; });
    options.process.onError((error) => this.fail(error));
    options.process.onExit((code, signal) => {
      if (!this.closing) this.fail(new Error(`MCP_STDIO_EXITED:${code ?? 'null'}:${signal ?? 'none'}:${this.stderr}`));
    });
    options.process.onClose(() => this.onClose());
  }

  private get scheduler(): StdioClientScheduler {
    return this.options.scheduler ?? systemStdioClientScheduler;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const boundary = this.stdoutBuffer.indexOf('\n');
      if (boundary < 0) return;
      const line = this.stdoutBuffer.slice(0, boundary);
      this.stdoutBuffer = this.stdoutBuffer.slice(boundary + 1);
      if (line.length === 0) continue;
      try {
        const response = responseSchema.parse(JSON.parse(line));
        if (this.completedIds.has(response.id)) throw new TypeError(`MCP_STDIO_DUPLICATE_RESPONSE_ID:${response.id}`);
        const pending = this.pending.get(response.id);
        if (pending === undefined) throw new TypeError(`MCP_STDIO_UNEXPECTED_ID:${response.id}`);
        this.pending.delete(response.id);
        this.completedIds.add(response.id);
        pending.timeout.cancel();
        pending.resolve(response);
      } catch (error) {
        this.fail(error instanceof Error ? error : new TypeError('MCP_STDIO_INVALID_FRAME'));
      }
    }
  }

  private fail(error: Error): void {
    this.protocolFailure ??= error;
    for (const pending of this.pending.values()) {
      pending.timeout.cancel();
      pending.reject(this.protocolFailure);
    }
    this.pending.clear();
  }

  private onClose(): void {
    this.closed = true;
    this.terminationTask?.cancel();
    this.killTask?.cancel();
    if (this.pending.size > 0) this.fail(new TypeError('MCP_STDIO_CLOSED_WITH_PENDING_REQUESTS'));
    if (this.stdoutBuffer.trim().length > 0) this.fail(new TypeError('MCP_STDIO_TRUNCATED_FRAME'));
    const waiter = this.closeWaiter;
    this.closeWaiter = undefined;
    if (waiter === undefined) return;
    const failure = this.protocolFailure;
    if (failure === undefined) waiter.resolve();
    else waiter.reject(failure);
  }

  ready(): Promise<void> {
    const marker = this.options.readyMarker ?? 'sangfor-engineer-mcp stdio server started';
    if (this.stderr.includes(marker)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = this.scheduler.schedule(this.options.responseTimeoutMs ?? 10_000, () => {
        reject(new Error(`MCP_STDIO_READY_TIMEOUT:${this.stderr}`));
      });
      this.options.process.onStderr(() => {
        if (!this.stderr.includes(marker)) return;
        timeout.cancel();
        resolve();
      });
      this.options.process.onClose(() => {
        timeout.cancel();
        reject(this.protocolFailure ?? new Error(`MCP_STDIO_READY_CLOSED:${this.stderr}`));
      });
    });
  }

  request(id: JsonRpcId, method: string, params: unknown): Promise<unknown> {
    if (this.issuedIds.has(id)) return Promise.reject(new TypeError(`MCP_STDIO_DUPLICATE_REQUEST_ID:${id}`));
    if (this.protocolFailure !== undefined) return Promise.reject(this.protocolFailure);
    if (this.closing || this.closed) return Promise.reject(new TypeError('MCP_STDIO_CLIENT_CLOSING'));
    this.issuedIds.add(id);
    return new Promise((resolve, reject) => {
      const timeout = this.scheduler.schedule(this.options.responseTimeoutMs ?? 10_000, () => {
        this.pending.delete(id);
        const error = new Error(`MCP_STDIO_RESPONSE_TIMEOUT:${id}:${this.stderr}`);
        this.fail(error);
        reject(error);
      });
      this.pending.set(id, { resolve, reject, timeout });
      this.options.process.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    if (this.closed) return this.protocolFailure === undefined ? Promise.resolve() : Promise.reject(this.protocolFailure);
    this.closing = true;
    this.closePromise = new Promise((resolve, reject) => {
      this.closeWaiter = { resolve, reject };
      this.terminationTask = this.scheduler.schedule(this.options.terminationTimeoutMs ?? 5_000, () => {
        this.killTask = this.scheduler.schedule(this.options.killTimeoutMs ?? 5_000, () => {
          this.closeWaiter = undefined;
          reject(new Error('MCP_STDIO_CLOSE_TIMEOUT'));
        });
        this.options.process.kill('SIGKILL');
      });
    });
    this.options.process.endInput();
    this.options.process.kill('SIGTERM');
    return this.closePromise;
  }
}
