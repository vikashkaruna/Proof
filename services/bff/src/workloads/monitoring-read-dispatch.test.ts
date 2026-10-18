import { createClient } from '@supabase/supabase-js';
import { afterEach, expect, it, vi } from 'vitest';
import { MonitoringReadDispatch } from './monitoring-read-dispatch.js';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const id = (n: number) => `65710000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ref = { tenantId: id(1), fireId: id(2) };
const assignment = { ...ref, state: 'runnable', requestId: id(3) };
const confirmed = { ...ref, state: 'confirmed', cleanupConfirmed: true, receiptId: '12' };
const unknown = { ...ref, state: 'unconfirmed', cleanupConfirmed: null, receiptId: null };
function fixture(responses: { value: unknown; status?: number }[]) {
  const fetcher = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw Error('Unexpected backend operation');
    return new Response(JSON.stringify(next.value), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const db = createClient('https://db.test.invalid', 'synthetic-key', {
    global: { fetch: fetcher },
    auth: { persistSession: false },
  });
  const identity = vi.fn(async () => {});
  const discovery = {
    run: vi.fn(async () => ({ workerStatus: 'read_completed' as const, cleanupConfirmed: true })),
  };
  return {
    fetcher,
    identity,
    discovery,
    bridge: new MonitoringReadDispatch(db, ref.tenantId, discovery, identity),
  };
}
it('reserves only a configured tenant opaque fire reference', async () => {
  const f = fixture([{ value: { fires: [ref] } }]);
  expect(await f.bridge.reserve()).toEqual({ fires: [ref] });
  expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body))).toEqual({
    p_tenant_id: ref.tenantId,
  });
  expect(f.discovery.run).not.toHaveBeenCalled();
});
it.each([
  { fires: [{ ...ref, tenantId: id(9) }] },
  { fires: [ref, ref] },
  { fires: [{ ...ref, actorId: id(9) }] },
])('refuses foreign, oversized and authority-bearing queue data', async (value) => {
  await expect(fixture([{ value }]).bridge.reserve()).rejects.toThrow();
});
it('hands off one exact retained request and records real supervisor cleanup, without a saved human identity', async () => {
  const f = fixture([{ value: assignment }, { value: confirmed }]);
  expect(await f.bridge.run(ref)).toEqual(confirmed);
  expect(f.discovery.run).toHaveBeenCalledExactlyOnceWith(ref.tenantId, id(3));
  expect(f.identity).toHaveBeenCalledTimes(3);
  expect(JSON.parse(String(f.fetcher.mock.calls[1]![1]!.body))).toEqual({
    p_tenant_id: ref.tenantId,
    p_fire_id: ref.fireId,
    p_request_id: id(3),
    p_worker_status: 'read_completed',
    p_cleanup_confirmed: true,
  });
});
it('rejects a foreign tenant before identity or backend access', async () => {
  const f = fixture([]);
  await expect(f.bridge.run({ ...ref, tenantId: id(9) })).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.identity).not.toHaveBeenCalled();
});
it('does not claim on an aborted caller or unavailable current controller identity', async () => {
  const f = fixture([]);
  const abort = new AbortController();
  abort.abort();
  expect(await f.bridge.run(ref, abort.signal)).toEqual(unknown);
  f.identity.mockRejectedValueOnce(Error('Revoked'));
  expect(await f.bridge.run(ref)).toEqual(unknown);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it('rechecks identity after claim and refuses handoff when trust retires', async () => {
  const f = fixture([{ value: assignment }]);
  f.identity.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('Retired'));
  expect(await f.bridge.run(ref)).toEqual(unknown);
  expect(f.discovery.run).not.toHaveBeenCalled();
});
it('reconciles a lost claim response without another mutation or worker launch', async () => {
  const f = fixture([{ value: { message: 'Unavailable' }, status: 503 }, { value: unknown }]);
  expect(await f.bridge.run(ref)).toEqual(unknown);
  expect(f.discovery.run).not.toHaveBeenCalled();
  expect(f.fetcher.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual([
    'claim_monitoring_read_dispatch',
    'read_monitoring_read_dispatch',
  ]);
});
it('reconciles a lost settlement using the same fire, never relaunching completed work', async () => {
  const f = fixture([{ value: assignment }, { value: {}, status: 503 }, { value: confirmed }]);
  expect(await f.bridge.run(ref)).toEqual(confirmed);
  expect(f.discovery.run).toHaveBeenCalledTimes(1);
  expect(String(f.fetcher.mock.calls[2]![0])).toContain('read_monitoring_read_dispatch');
});
it('does not repeat a one-shot handoff already recorded as unconfirmed', async () => {
  const f = fixture([{ value: unknown }]);
  expect(await f.bridge.run(ref)).toEqual(unknown);
  expect(f.discovery.run).not.toHaveBeenCalled();
});
it.each([
  { ...confirmed, fireId: id(9) },
  { ...confirmed, cleanupConfirmed: false },
  { ...confirmed, receiptId: '9999999999999999999' },
])('does not publish invalid or foreign success receipts', async (value) => {
  const f = fixture([{ value: assignment }, { value }]);
  expect(await f.bridge.run(ref)).toEqual(unknown);
});

it('bounds all backend RPCs and propagates caller cancellation', async () => {
  const f = fixture([
    { value: { fires: [ref] } },
    { value: assignment },
    { value: confirmed },
    { value: confirmed },
  ]);
  await f.bridge.reserve();
  await f.bridge.run(ref);
  await f.bridge.reconcile(ref);
  for (const [, init] of f.fetcher.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
  const pending = fixture([]);
  const caller = new AbortController();
  pending.fetcher.mockImplementationOnce(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true });
      }),
  );
  const work = pending.bridge.reserve(caller.signal);
  await vi.waitFor(() => expect(pending.fetcher).toHaveBeenCalledOnce());
  caller.abort();
  await expect(work).rejects.toThrow('queue unavailable');
  expect(pending.discovery.run).not.toHaveBeenCalled();
});
it('does not hang a backend queue read beyond its fixed deadline', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  });
  const f = fixture([]);
  f.fetcher.mockImplementationOnce(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Error('deadline')), { once: true });
      }),
  );
  const work = expect(f.bridge.reserve()).rejects.toThrow('queue unavailable');
  await vi.advanceTimersByTimeAsync(5001);
  await work;
});
it('a restarted bridge reads the original orphan reference without launching a second worker', async () => {
  const f = fixture([
    { value: { fires: [ref] } },
    { value: unknown },
    { value: { ...unknown, cleanupConfirmed: false, receiptId: '15' } },
  ]);
  expect(await f.bridge.reserve()).toEqual({ fires: [ref] });
  expect(await f.bridge.run(ref)).toEqual(unknown);
  expect(f.discovery.run).not.toHaveBeenCalled();
  expect(await f.bridge.reconcile(ref)).toEqual({
    ...unknown,
    cleanupConfirmed: false,
    receiptId: '15',
  });
  expect(f.discovery.run).not.toHaveBeenCalled();
});
