import { describe, expect, it } from 'vitest';
import {
  boundedRequestBody,
  RequestBodyTooLarge,
  RequestBodyUnavailable,
} from './bounded-request-body';

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
  it.each(['deadline', 'abort', 'already-aborted'])(
    'releases a stalled stream on %s even when cancellation never resolves',
    async (mode) => {
      let cancelled = false;
      const controller = new AbortController();
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
          return new Promise<void>(() => undefined);
        },
      });
      const input = new Request('https://example.test/upload', {
        method: 'POST',
        body: stream,
        signal: controller.signal,
        ...{ duplex: 'half' },
      });
      if (mode === 'already-aborted') controller.abort();
      const pending = boundedRequestBody(input, 4, 20);
      if (mode === 'abort') controller.abort();
      await expect(pending).rejects.toBeInstanceOf(RequestBodyUnavailable);
      expect(cancelled).toBe(true);
      expect(stream.locked).toBe(false);
    },
  );
  it.each([undefined, '5'])('never waits for oversized body cancellation (%s)', async (length) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        return new Promise<void>(() => undefined);
      },
    });
    const input = new Request('https://example.test/upload', {
      method: 'POST',
      body: stream,
      headers: length ? { 'content-length': length } : {},
      ...{ duplex: 'half' },
    });
    await expect(boundedRequestBody(input, 4, 20)).rejects.toBeInstanceOf(RequestBodyTooLarge);
    expect(stream.locked).toBe(false);
  });
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
