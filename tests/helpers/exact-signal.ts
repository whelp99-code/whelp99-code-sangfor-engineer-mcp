export class ExactSignalTimeoutError extends Error {
  override readonly name = 'ExactSignalTimeoutError';
  constructor(readonly label: string) {
    super(`Timed out waiting for exact test event: ${label}`);
  }
}

export class ExactSignal {
  readonly promise: Promise<void>;
  private complete: () => void = () => undefined;

  constructor(label: string, timeoutMs = 5_000) {
    const timeout = AbortSignal.timeout(timeoutMs);
    this.promise = new Promise((resolve, reject) => {
      const onTimeout = () => reject(new ExactSignalTimeoutError(label));
      timeout.addEventListener('abort', onTimeout, { once: true });
      this.complete = () => {
        timeout.removeEventListener('abort', onTimeout);
        resolve();
      };
    });
  }

  resolve(): void {
    this.complete();
  }
}
