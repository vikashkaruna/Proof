import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentInvocationError, invokeAgent } from './invoke-agent';
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
  const reply = await invokeAgent('drishti', {
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
    await expect(invokeAgent('drishti')).rejects.toThrow(AgentInvocationError);
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
  await expect(invokeAgent('drishti')).rejects.toThrow(AgentInvocationError);
});
it('displays the bounded public BFF explanation for an unconfirmed persisted outcome', async () => {
  transport.mockResolvedValue(
    new Response(JSON.stringify({ error: { message: 'Inspect this run before retrying.' } }), {
      status: 503,
    }),
  );
  await expect(invokeAgent('drishti')).rejects.toThrow('Inspect this run before retrying.');
});
it('sanitizes network and malformed response errors', async () => {
  transport.mockRejectedValueOnce(new Error('private-network-detail'));
  await expect(invokeAgent('drishti')).rejects.toThrow('The agent outcome could not be confirmed.');
  transport.mockResolvedValueOnce(new Response('private-invalid-json'));
  await expect(invokeAgent('drishti')).rejects.toThrow('The agent outcome could not be confirmed.');
});
it('rejects invalid agent paths before dispatch', async () => {
  await expect(invokeAgent('../admin')).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
