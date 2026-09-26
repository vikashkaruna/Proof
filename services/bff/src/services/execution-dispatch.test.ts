import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchExecution } from './execution-dispatch.js';

/**
 * W5 · M3.4 — the runtime is now a real executor. Its acknowledgement
 * carries the recorded batch, whose id is the durable reference the
 * outbox records; `contract_version` must be the version the BFF
 * dispatched (2). Anything ambiguous stays `unknown`: actions are not
 * released on a response that says nothing.
 */

const payload = { correlation_id: 'batch-1' };
const ack = {
  accepted: true,
  contract_version: 2,
  correlation_id: 'batch-1',
  batch: { id: 'batch-1', status: 'completed', replay: false },
  outcomes: [
    { action_id: '44444444-4444-4444-8444-44444444000a', outcome: 'succeeded', error_code: null },
    {
      action_id: '44444444-4444-4444-8444-44444444000b',
      outcome: 'skipped',
      error_code: 'kill_switch_engaged',
    },
  ],
};
afterEach(() => vi.unstubAllGlobals());

describe('dispatch responsibility', () => {
  it('accepts an explicit correlated acknowledgement with the recorded batch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(ack)));
    expect(await dispatchExecution('http://runtime', 'internal', payload)).toEqual({
      status: 'accepted',
      reference: 'batch-1',
      error: null,
      outcomes: ack.outcomes.map((o) => ({
        actionId: o.action_id,
        outcome: o.outcome,
        errorCode: o.error_code,
      })),
    });
  });
  it('accepts a bare durable reference for callers without a batch object', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({ ...ack, batch: undefined, reference: 'durable-1' })),
    );
    expect(await dispatchExecution('http://runtime', 'internal', payload)).toMatchObject({
      status: 'accepted',
      reference: 'durable-1',
    });
  });
  it('records a refusal as failed, never as work running', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ ...ack, accepted: false, batch: undefined }, { status: 409 }),
        ),
    );
    expect(await dispatchExecution('http://runtime', 'internal', payload)).toMatchObject({
      status: 'failed',
    });
  });
  it.each([
    {},
    { ...ack, accepted: 'true' },
    { ...ack, correlation_id: 'other-batch' },
    { ...ack, contract_version: 1 },
    { ...ack, batch: undefined },
    { ...ack, batch: {} },
    { ...ack, outcomes: [{ action_id: 'not-a-uuid', outcome: 'succeeded', error_code: null }] },
    {
      ...ack,
      outcomes: [
        {
          action_id: '44444444-4444-4444-8444-44444444000a',
          outcome: 'invented',
          error_code: null,
        },
      ],
    },
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
