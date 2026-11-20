interface Operation<T> {
  readonly reload: boolean;
  readonly run: () => Promise<T>;
  readonly promise: Promise<T>;
  resolve(result: T): void;
  reject(error: unknown): void;
}

/** A mutation is a barrier; only adjacent reloads that have not started may share a pass. */
export class HostQueue<T> {
  private readonly pending: Operation<T>[] = [];
  private running: Promise<void> | undefined;
  private closed: Error | undefined;

  enqueue(reload: boolean, run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const previous = this.pending.at(-1);
    if (reload && previous?.reload) return previous.promise;
    let resolve!: (result: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.pending.push({ reload, run, promise, resolve, reject });
    if (!this.running) {
      this.running = Promise.resolve().then(() => this.drain());
    }
    return promise;
  }

  close(error: Error): Promise<void> {
    this.closed = error;
    for (const operation of this.pending.splice(0)) operation.reject(error);
    return this.running ?? Promise.resolve();
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const operation = this.pending.shift()!;
        try {
          operation.resolve(await operation.run());
        } catch (error: unknown) {
          operation.reject(error);
        }
      }
    } finally {
      this.running = undefined;
    }
  }
}
