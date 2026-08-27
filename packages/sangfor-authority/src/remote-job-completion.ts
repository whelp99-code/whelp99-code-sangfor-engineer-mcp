import { createHash } from 'node:crypto';
import { Client } from 'pg';

export const REMOTE_JOB_COMPLETION_CHANNEL = 'blro_remote_job_completion';

export type RemoteJobCompletionIdentity = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly jobId: string;
  readonly authorityEpoch: number;
};

export interface RemoteJobCompletionObserver {
  ready(): Promise<void>;
  wait(completionKey: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export function remoteJobCompletionKey(input: RemoteJobCompletionIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    input.tenantId, input.projectId, input.installationId, input.jobId, input.authorityEpoch,
  ])).digest('hex');
}

export function createPostgresRemoteJobCompletionObserver(
  databaseUrl: string,
): RemoteJobCompletionObserver {
  const client = new Client({ connectionString: databaseUrl,
    application_name: `blro-completion-${String(process.pid)}` });
  const observed = new Set<string>();
  const waiters = new Map<string, Set<() => void>>();
  let connected: Promise<void> | undefined;

  const ready = (): Promise<void> => {
    connected ??= client.connect().then(async () => {
      client.on('notification', (message) => {
        const key = message.payload;
        if (!key) return;
        const listeners = waiters.get(key);
        if (!listeners) { observed.add(key); return; }
        waiters.delete(key);
        for (const resolve of listeners) resolve();
      });
      await client.query(`LISTEN ${REMOTE_JOB_COMPLETION_CHANNEL}`);
    });
    return connected;
  };

  return {
    ready,
    async wait(completionKey: string, signal: AbortSignal): Promise<void> {
      await ready();
      if (observed.delete(completionKey)) return;
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = (): void => {
          const listeners = waiters.get(completionKey);
          listeners?.delete(finish);
          if (listeners?.size === 0) waiters.delete(completionKey);
          reject(signal.reason);
        };
        const listeners = waiters.get(completionKey) ?? new Set<() => void>();
        listeners.add(finish);
        waiters.set(completionKey, listeners);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    async close(): Promise<void> {
      if (connected) await client.end();
    },
  };
}
