import { describe, expect, it } from 'vitest';
import { boundedRequestBody, RequestBodyTooLarge } from './bounded-request-body';

function request(chunks: number[][], declaredLength?: string) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  const input = new Request('https://example.test/upload', {
    method: 'POST',
    body: stream,
    headers: declaredLength ? { 'content-length': declaredLength } : {},
    // Node requires half duplex for streaming Request bodies.
    ...{ duplex: 'half' },
  });
  return { input, wasCancelled: () => cancelled };
}

describe('bounded proxy bodies', () => {
  it.each([undefined, '1'])(
    'cancels oversized chunked bodies despite declared length %s',
    async (length) => {
      const fixture = request([[1, 2], [3, 4], [5]], length);
      await expect(boundedRequestBody(fixture.input, 4)).rejects.toBeInstanceOf(
        RequestBodyTooLarge,
      );
      expect(fixture.wasCancelled()).toBe(true);
    },
  );
  it('refuses a declared excess before reading and cancels the stream', async () => {
    const fixture = request([[1]], '5');
    await expect(boundedRequestBody(fixture.input, 4)).rejects.toBeInstanceOf(RequestBodyTooLarge);
    expect(fixture.wasCancelled()).toBe(true);
  });
  it('preserves every byte at the exact limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Uint8Array.from([0, 255]));
        c.enqueue(Uint8Array.from([10, 13]));
        c.close();
      },
    });
    const input = new Request('https://example.test/upload', {
      method: 'POST',
      body,
      ...{ duplex: 'half' },
    });
    expect([...new Uint8Array(await boundedRequestBody(input, 4))]).toEqual([0, 255, 10, 13]);
  });
  it('accepts an absent body without fabricating bytes', async () => {
    expect(
      (await boundedRequestBody(new Request('https://example.test/upload'), 4)).byteLength,
    ).toBe(0);
  });
});
