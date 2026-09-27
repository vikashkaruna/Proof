/** Mirrors the PostgREST abort surface for cancellation-aware transport tests. */
export function abortableResult<T>(work: Promise<T>) {
  return Object.assign(work, {
    abortSignal(signal: AbortSignal): Promise<T> {
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    },
  });
}
