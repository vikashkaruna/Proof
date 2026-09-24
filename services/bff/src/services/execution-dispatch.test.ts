import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchExecution } from './execution-dispatch.js';

const payload = { correlation_id: 'batch-1' };
const ack = {
  accepted: true,
  contract_version: 1,
  correlation_id: 'batch-1',
  reference: 'durable-1',
};
afterEach(() => vi.unstubAllGlobals());

describe('dispatch responsibility', () => {
  it('accepts an explicit correlated acknowledgement with a durable reference', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(ack)));
    expect(await dispatchExecution('http://runtime', 'internal', payload)).toEqual({
      status: 'accepted',
      reference: 'durable-1',
      error: null,
    });
  });
  it('records the current runtime stub as a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ ...ack, accepted: false }, { status: 501 })),
    );
    expect(await dispatchExecution('http://runtime', 'internal', payload)).toMatchObject({
      status: 'failed',
    });
  });
  it.each([
    {},
    { ...ack, accepted: 'true' },
    { ...ack, correlation_id: 'other-batch' },
    { ...ack, contract_version: 2 },
    { ...ack, reference: undefined },
  ])('does not release actions for ambiguous acknowledgement %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    expect(await dispatchExecution('http://runtime', 'internal', payload)).toMatchObject({
      status: 'unknown',
    });
  });
  it('does not turn an upstream 500 into permission to retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 500 })));
    expect(await dispatchExecution('http://runtime', 'internal', payload)).toMatchObject({
      status: 'unknown',
    });
  });
  it('retains responsibility after a lost response without persisting arbitrary error text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret token in upstream error')));
    const result = await dispatchExecution('http://runtime', 'internal', payload);
    expect(result.status).toBe('unknown');
    expect(result.error).not.toContain('secret token');
  });
  it('can safely refuse before making any request if the runtime is unconfigured', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await dispatchExecution(undefined, 'internal', payload)).toMatchObject({
      status: 'failed',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
