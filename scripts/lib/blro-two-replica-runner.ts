import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { get } from 'node:http';
import {
  browserExecutionResultSchema,
  type BrowserExecutionResult,
} from '../../packages/sangfor-browser-contracts/src/index.js';
import {
  childMessageSchema,
  type ParentMessage,
  type ReplicaConfig,
} from './blro-two-replica-types.js';

type EventName = 'reserved' | 'waiting' | 'dispatch-boundary' | 'result-retained';
type Pending = {
  readonly resolve: (result: BrowserExecutionResult) => void;
  readonly reject: (error: Error) => void;
};

export class ReplicaProcess {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly lifecycle = new Map<string, Map<EventName, () => void>>();
  constructor(readonly config: ReplicaConfig, readonly entrypoint: string) {}

  async start(): Promise<void> {
    const child = fork(this.entrypoint, ['--child'], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: process.env,
    });
    this.child = child;
    const ready = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new ReplicaHarnessError(`REPLICA_START_EXIT_${String(code)}`)));
      child.on('message', (raw: unknown) => {
        const message = childMessageSchema.parse(raw);
        switch (message.kind) {
          case 'ready': resolve(); return;
          case 'lifecycle': this.lifecycle.get(message.id)?.get(message.event)?.(); return;
          case 'result': {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            pending.resolve(browserExecutionResultSchema.parse(message.result));
            return;
          }
          case 'failure': {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            pending.reject(new ReplicaHarnessError(message.code));
            return;
          }
          default: return assertNever(message);
        }
      });
    });
    child.send({ kind: 'config', config: this.config });
    await Promise.race([ready, abortAfter(10_000)]);
  }

  submit(input: { readonly bodyText: string; readonly purpose?: 'mutation' | 'verification';
    readonly failpoint?: 'none' | 'pre_commit' | 'post_commit' }): { readonly id: string;
      readonly result: Promise<BrowserExecutionResult>;
      readonly events: Readonly<Record<EventName, Promise<void>>> } {
    const id = randomUUID();
    const result = new Promise<BrowserExecutionResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const resolvers = new Map<EventName, () => void>();
    const events = {
      reserved: new Promise<void>((resolve) => { resolvers.set('reserved', resolve); }),
      waiting: new Promise<void>((resolve) => { resolvers.set('waiting', resolve); }),
      'dispatch-boundary': new Promise<void>((resolve) => { resolvers.set('dispatch-boundary', resolve); }),
      'result-retained': new Promise<void>((resolve) => { resolvers.set('result-retained', resolve); }),
    };
    this.lifecycle.set(id, resolvers);
    this.send({ kind: 'submit', id, bodyText: input.bodyText,
      purpose: input.purpose ?? 'mutation', failpoint: input.failpoint ?? 'none' });
    return { id, result, events };
  }

  release(id: string): void { this.send({ kind: 'release', id }); }

  readiness(): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = get({ host: '127.0.0.1', port: this.config.port, path: '/ready',
        signal: AbortSignal.timeout(5_000) }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
    });
  }

  async kill(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit').then(() => undefined), abortAfter(10_000)]);
    this.child = undefined;
    for (const pending of this.pending.values()) pending.reject(new ReplicaHarnessError('REPLICA_DIED'));
    this.pending.clear();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.send({ kind: 'stop' });
    await Promise.race([once(child, 'exit').then(() => undefined), abortAfter(10_000)]);
    this.child = undefined;
  }

  private send(message: ParentMessage): void {
    if (!this.child?.send) throw new ReplicaHarnessError('REPLICA_NOT_RUNNING');
    this.child.send(message);
  }
}

function abortAfter(milliseconds: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = AbortSignal.timeout(milliseconds);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
function assertNever(value: never): never { throw new TypeError(JSON.stringify(value)); }
export class ReplicaHarnessError extends Error { override readonly name = 'ReplicaHarnessError'; }
