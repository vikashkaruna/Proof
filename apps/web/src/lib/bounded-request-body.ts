/** Bound bytes while streaming, including requests that omit or understate Content-Length. */
export class RequestBodyTooLarge extends Error {
  constructor() {
    super('request_body_too_large');
  }
}

export class RequestBodyUnavailable extends Error {
  constructor() {
    super('request_body_unavailable');
  }
}

export async function boundedRequestBody(
  request: Request,
  maxBytes: number,
  timeoutMs = 30_000,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid_body_limit');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid_body_timeout');
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    void request.body?.cancel().catch(() => undefined);
    throw new RequestBodyTooLarge();
  }
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let abortRead: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abortRead = () => reject(new RequestBodyUnavailable());
  });
  const deadline = setTimeout(abortRead, timeoutMs);
  request.signal.addEventListener('abort', abortRead, { once: true });
  if (request.signal.aborted) abortRead();
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new RequestBodyTooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    // A hostile stream can also stall cancellation; never await its hook.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(deadline);
    request.signal.removeEventListener('abort', abortRead);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
