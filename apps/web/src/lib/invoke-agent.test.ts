import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentInvocationError, invokeAgent } from './invoke-agent';
const TENANT = '10000000-0000-4000-8000-000000000001';
const transport = vi.fn<typeof fetch>();
function result(init?: RequestInit, changes: Record<string, unknown> = {}) {
  const input = JSON.parse(String(init?.body)) as { correlation_id: string };
  return {
    agent: 'drishti',
    correlation_id: input.correlation_id,
    status: 'succeeded',
    error: null,
    output: {},
    latency_ms: 10,
    ledger_entry_ids: ['1', '2'],
    ...changes,
  };
}
beforeEach(() => {
  transport.mockReset();
  vi.stubGlobal('fetch', transport);
});
afterEach(() => vi.unstubAllGlobals());
it('sends JSON with a fresh correlation and accepts only the matching confirmed result', async () => {
  transport.mockImplementation(async (_url, init) => new Response(JSON.stringify(result(init))));
  const reply = await invokeAgent('drishti', TENANT, {
    correlation_id: 'caller-value',
    scope: 'workbench',
  });
  expect(reply.status).toBe('succeeded');
  expect(reply.correlation_id).not.toBe('caller-value');
  const [url, request] = transport.mock.calls[0]!;
  expect(url).toBe('/api/bff/v1/agents/drishti/run');
  expect(JSON.parse(String(request?.body))).toMatchObject({
    scope: 'workbench',
    correlation_id: reply.correlation_id,
  });
  expect(request?.redirect).toBe('error');
});
it.each([400, 401, 403, 500, 502, 503])(
  'refuses HTTP %i even with a success-shaped body',
  async (status) => {
    transport.mockImplementation(
      async (_url, init) => new Response(JSON.stringify(result(init)), { status }),
    );
    await expect(invokeAgent('drishti', TENANT)).rejects.toThrow(AgentInvocationError);
  },
);
it.each([
  { status: undefined },
  { status: 'failed' },
  { agent: 'sudhaar' },
  { correlation_id: 'foreign' },
  { error: 'failed' },
  { output: null },
  { ledger_entry_ids: [] },
  { ledger_entry_ids: ['1', '1'] },
  { latency_ms: -1 },
])('refuses an unconfirmed/mismatched result %j', async (change) => {
  transport.mockImplementation(
    async (_url, init) => new Response(JSON.stringify(result(init, change))),
  );
  await expect(invokeAgent('drishti', TENANT)).rejects.toThrow(AgentInvocationError);
});
it('displays the bounded public BFF explanation for an unconfirmed persisted outcome', async () => {
  transport.mockResolvedValue(
    new Response(JSON.stringify({ error: { message: 'Inspect this run before retrying.' } }), {
      status: 503,
    }),
  );
  await expect(invokeAgent('drishti', TENANT)).rejects.toThrow('Inspect this run before retrying.');
});
it('sanitizes network and malformed response errors', async () => {
  transport.mockRejectedValueOnce(new Error('private-network-detail'));
  await expect(invokeAgent('drishti', TENANT)).rejects.toThrow(
    'The agent outcome could not be confirmed.',
  );
  transport.mockResolvedValueOnce(new Response('private-invalid-json'));
  await expect(invokeAgent('drishti', TENANT)).rejects.toThrow(
    'The agent outcome could not be confirmed.',
  );
});
it('rejects invalid agent paths before dispatch', async () => {
  await expect(invokeAgent('../admin', TENANT)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it('invokes using a secure UUID fallback when HTTP does not expose randomUUID', async () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.fill(17);
    return bytes;
  });
  vi.stubGlobal('crypto', { getRandomValues });
  transport.mockImplementation(async (_url, init) => Response.json(result(init)));
  const reply = await invokeAgent('drishti', TENANT);
  expect(reply.correlation_id).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(getRandomValues).toHaveBeenCalledOnce();
  expect(transport).toHaveBeenCalledOnce();
});
it.each(['rng', 'serialization'])(
  'reports a never-sent %s invocation failure separately from unknown outcomes',
  async (failure) => {
    vi.stubGlobal('crypto', failure === 'rng' ? {} : { randomUUID: () => 'correlation-test' });
    const input: Record<string, unknown> = {};
    if (failure === 'serialization') input.self = input;
    await expect(invokeAgent('drishti', TENANT, input)).rejects.toThrow(
      'The agent request could not be prepared. Nothing was sent.',
    );
    expect(transport).not.toHaveBeenCalled();
  },
);

it('binds dispatch to the explicit rendered tenant rather than a later cookie selection', async () => {
  transport.mockImplementation(async (_url, init) => Response.json(result(init)));
  await invokeAgent('drishti', '10000000-0000-4000-8000-000000000001', { scope: 'manual_trigger' });
  expect(transport.mock.calls[0]![1]?.headers).toMatchObject({
    'X-Tenant-Id': '10000000-0000-4000-8000-000000000001',
  });
  expect(JSON.parse(String(transport.mock.calls[0]![1]?.body))).toMatchObject({
    tenant_id: '10000000-0000-4000-8000-000000000001',
    scope: 'manual_trigger',
  });
});
it.each([undefined, '', 'not-a-tenant'])(
  'refuses missing or invalid tenant %s before dispatch',
  async (tenant) => {
    await expect(invokeAgent('drishti', tenant as string)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  },
);
it.each(['tenant_id', 'tenantId'])(
  'refuses a conflicting input %s before dispatch',
  async (key) => {
    await expect(
      invokeAgent('drishti', '10000000-0000-4000-8000-000000000001', {
        [key]: '20000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  },
);
