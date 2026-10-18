/** Invocation-local, shortening-only authority deadline. Never a retry budget. */
export class PostgresDeadlineExceeded extends Error {
  constructor() {
    super('PostgreSQL authority deadline exceeded');
  }
}
export class PostgresDeadline {
  readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: number;
  private readonly externalAbort = () => this.abort();
  constructor(
    deadline: number,
    private readonly now: () => number = Date.now,
    private readonly external?: AbortSignal,
  ) {
    this.deadline = deadline;
    external?.addEventListener('abort', this.externalAbort, { once: true });
    if (external?.aborted) this.abort();
    this.tighten(deadline);
  }
  get expiresAt(): number {
    return this.deadline;
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  tighten(deadline: number) {
    this.deadline = Math.min(this.deadline, deadline);
    clearTimeout(this.timer);
    const remaining = this.deadline - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || this.signal.aborted) {
      this.abort();
      return;
    }
    this.timer = setTimeout(() => this.abort(), remaining);
  }
  abort() {
    this.controller.abort();
  }
  async run<T>(operation: () => PromiseLike<T>): Promise<T> {
    if (this.signal.aborted || this.now() >= this.deadline) {
      this.abort();
      throw new PostgresDeadlineExceeded();
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new PostgresDeadlineExceeded());
      this.signal.addEventListener('abort', abort, { once: true });
      let pending: PromiseLike<T>;
      try {
        pending = operation();
      } catch (error) {
        this.signal.removeEventListener('abort', abort);
        reject(error);
        return;
      }
      Promise.resolve(pending).then(
        (result) => {
          this.signal.removeEventListener('abort', abort);
          if (this.signal.aborted || this.now() >= this.deadline) {
            this.abort();
            reject(new PostgresDeadlineExceeded());
          } else resolve(result);
        },
        (error: unknown) => {
          this.signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }
  dispose() {
    clearTimeout(this.timer);
    this.external?.removeEventListener('abort', this.externalAbort);
  }
}
