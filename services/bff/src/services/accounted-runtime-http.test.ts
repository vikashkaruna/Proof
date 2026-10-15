import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { accountedRuntimeHttpPort } from './accounted-runtime-http.js';
const { cases } = JSON.parse(
  readFileSync(
    new URL('../../../../tests/fixtures/model-accounting/accounted-results.json', import.meta.url),
    'utf8',
  ),
) as { cases: { name: string; wire_text: string; runtime_output_text: string | null }[] };
for (const p of cases)
  it(`bounded exact ${p.name} HTTP transport`, async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(p.wire_text));
    const port = accountedRuntimeHttpPort({
      runtimeUrl: 'http://fixture.invalid',
      internalToken: 'synthetic-nonoperational-peer',
      fetchImpl,
      authHeaders: async () => ({}),
    });
    const actual = (await port.invoke({
      tenant_id: '10000000-0000-4000-8000-000000000001',
      run_id: '10000000-0000-4000-8000-000000000002',
      request_sha256: 'a'.repeat(64),
    })) as { runtime_output_text: string | null };
    expect(actual.runtime_output_text).toBe(p.runtime_output_text);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![1]?.redirect).toBe('error');
  });
for (const [status, body] of [
  [302, '{}'],
  [503, 'private-canary'],
  [200, '{"x":1,"x":1}'],
  [200, 'x'.repeat(2097153)],
] as const)
  it(`refuses ${status}/${body.length} once`, async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
    const port = accountedRuntimeHttpPort({
      runtimeUrl: 'http://fixture.invalid',
      internalToken: 'synthetic-nonoperational-peer',
      fetchImpl,
      authHeaders: async () => ({}),
    });
    await expect(
      port.invoke({
        tenant_id: '10000000-0000-4000-8000-000000000001',
        run_id: '10000000-0000-4000-8000-000000000002',
        request_sha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow('accounted_result_contract_refused');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

it('total deadline bounds hanging auth and forbids dispatch after late auth resolution', async () => {
  vi.useFakeTimers();
  try {
    let release: (value: Readonly<Record<string, string>>) => void = () => {};
    const authHeaders = vi.fn(
      () =>
        new Promise<Readonly<Record<string, string>>>((resolve) => {
          release = resolve;
        }),
    );
    const fetchImpl = vi.fn<typeof fetch>();
    const port = accountedRuntimeHttpPort({
      runtimeUrl: 'http://fixture.invalid',
      internalToken: 'synthetic-nonoperational-peer',
      authHeaders,
      fetchImpl,
    });
    const pending = port.invoke({
      tenant_id: '10000000-0000-4000-8000-000000000001',
      run_id: '10000000-0000-4000-8000-000000000002',
      request_sha256: 'a'.repeat(64),
    });
    const refused = expect(pending).rejects.toThrow('accounted_result_contract_refused');
    await vi.advanceTimersByTimeAsync(65000);
    await refused;
    release({});
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it('total deadline bounds injected fetch ignoring abort', async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const port = accountedRuntimeHttpPort({
      runtimeUrl: 'http://fixture.invalid',
      internalToken: 'synthetic-nonoperational-peer',
      fetchImpl,
      authHeaders: async () => ({}),
    });
    const refused = expect(
      port.invoke({
        tenant_id: '10000000-0000-4000-8000-000000000001',
        run_id: '10000000-0000-4000-8000-000000000002',
        request_sha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow('accounted_result_contract_refused');
    await vi.advanceTimersByTimeAsync(65000);
    await refused;
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
it('total deadline cancels hanging response body without awaiting uncooperative cleanup', async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}), cancel })),
      );
    const port = accountedRuntimeHttpPort({
      runtimeUrl: 'http://fixture.invalid',
      internalToken: 'synthetic-nonoperational-peer',
      fetchImpl,
      authHeaders: async () => ({}),
    });
    const refused = expect(
      port.invoke({
        tenant_id: '10000000-0000-4000-8000-000000000001',
        run_id: '10000000-0000-4000-8000-000000000002',
        request_sha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow('accounted_result_contract_refused');
    await vi.advanceTimersByTimeAsync(65000);
    await refused;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
