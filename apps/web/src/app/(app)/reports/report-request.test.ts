import { afterEach, describe, expect, it, vi } from 'vitest';
import { preparePackBody, reportRequest, readReleasedArchive } from './report-request';

const id = '11111111-1111-4111-8111-111111111111';
function form(fields: Record<string, string | undefined> = {}) {
  const result = new FormData();
  for (const [key, value] of Object.entries({
    title: ' Auditor evidence ',
    confirmed: 'on',
    ...fields,
  }))
    if (value !== undefined) result.set(key, value);
  return result;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('pack preparation', () => {
  it('submits only selected exact receipt references and explicit reviewed metadata', () => {
    expect(
      preparePackBody(
        form({ tenantId: 'forged', status: 'published', contentHash: 'forged' }),
        [id],
        id,
      ),
    ).toEqual({
      operationKey: id,
      title: 'Auditor evidence',
      evidenceReceiptIds: [id],
      engagementId: null,
    });
  });
  it('refuses absent review, empty/duplicate/too many/invalid selections and malformed metadata', () => {
    expect(() => preparePackBody(form({ confirmed: '' }), [id], id)).toThrow('Review');
    expect(() => preparePackBody(form(), [id, id], id)).toThrow('only once');
    for (const ids of [
      [],
      ['legacy'],
      Array.from(
        { length: 21 },
        (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
      ),
    ])
      expect(() => preparePackBody(form(), ids, id)).toThrow('1–20');
    for (const fields of [
      { title: ' ' },
      { title: 'x'.repeat(201) },
      { engagementId: 'not-an-id' },
    ])
      expect(() => preparePackBody(form(fields), [id], id)).toThrow('Enter a title');
  });
});

describe('released archive download', () => {
  const bytes = new TextEncoder().encode('synthetic archive');
  async function hash() {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  }
  it('accepts only the exact released bytes', async () => {
    const blob = await readReleasedArchive(new Response(bytes), bytes.length, await hash());
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });
  it('rejects overflow, truncation and a same-size substituted archive', async () => {
    const expectedHash = await hash();
    await expect(
      readReleasedArchive(new Response(bytes), bytes.length - 1, expectedHash),
    ).rejects.toThrow('exceeds');
    await expect(
      readReleasedArchive(new Response(bytes), bytes.length + 1, expectedHash),
    ).rejects.toThrow('size differs');
    await expect(
      readReleasedArchive(new Response(new Uint8Array(bytes.length)), bytes.length, expectedHash),
    ).rejects.toThrow('SHA-256');
  });
  it('times out stalled bodies even if cancellation never resolves', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const result = readReleasedArchive(
      new Response(new ReadableStream({ cancel })),
      1,
      'a'.repeat(64),
    );
    const assertion = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('refuses an unbounded or invalid declared archive before reading', async () => {
    for (const size of [0, 64 * 1024 * 1024 + 1, Number.NaN])
      await expect(readReleasedArchive(new Response(bytes), size, 'a'.repeat(64))).rejects.toThrow(
        'valid archive',
      );
  });
});

describe('report requests', () => {
  it('keeps tenant scope explicit, uses no cache, and does not invent an outcome on interrupted writes', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('private endpoint detail'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      reportRequest(id, '/evidence-packs', { body: { operationKey: id } }),
    ).rejects.toThrow('outcome is uncertain');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/bff/v1/evidence-packs',
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        headers: expect.objectContaining({ 'x-tenant-id': id }),
      }),
    );
  });
  it('shows a server refusal code without leaking its internal message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'stale_content', message: 'private storage address' },
          }),
          { status: 409 },
        ),
      ),
    );
    await expect(reportRequest(id, '/reports')).rejects.toThrow(/^stale_content$/);
  });
  it('does not turn a query outage into an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(reportRequest(id, '/reports')).rejects.toThrow(
      'Unable to load the recorded state',
    );
  });
});
