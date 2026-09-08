export class DrainTimeoutError extends Error {
  override readonly name = 'DrainTimeoutError';
  constructor(readonly outstanding: number) {
    super(`Drain timed out with ${String(outstanding)} in-flight job(s).`);
  }
}

/**
 * Counts in-flight jobs and settles the drain barrier on the exact completion
 * event of the last one. There is no polling and no timed sleep: a bounded
 * AbortSignal decides the timeout, and the idle event decides success.
 */
export class InFlightJobs {
  private active = 0;
  private readonly idle = new EventTarget();

  get outstanding(): number {
    return this.active;
  }

  enter(): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (this.active === 0) this.idle.dispatchEvent(new Event('idle'));
    };
  }

  async awaitIdle(signal: AbortSignal): Promise<void> {
    if (this.active === 0) return;
    await new Promise<void>((resolve, reject) => {
      const onIdle = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.idle.removeEventListener('idle', onIdle);
        reject(new DrainTimeoutError(this.active));
      };
      this.idle.addEventListener('idle', onIdle, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
