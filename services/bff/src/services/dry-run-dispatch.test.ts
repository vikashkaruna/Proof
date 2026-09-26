import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchDryRun } from './dry-run-dispatch.js';

const payload = { correlation_id: 'dry-1' };
const dryRun = {
  id: 'dr-1',
  status: 'succeeded',
  renderable: true,
  refusalReason: null,
  expiresAt: '2026-09-27T00:00:00+00:00',
  createdAt: '2026-09-26T00:00:00+00:00',
};
const ack = {
  accepted: true,
  contract_version: 1,
  correlation_id: 'dry-1',
  dry_run: dryRun,
};
afterEach(() => vi.unstubAllGlobals());

describe('dry-run dispatch responsibility', () => {
  it('returns a recorded result only for a correlated, well-formed acknowledgement', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(ack)));
    expect(await dispatchDryRun('http://runtime', 'internal', payload)).toEqual({
      status: 'recorded',
      dryRunId: 'dr-1',
      outcome: 'succeeded',
      refusalReason: null,
      error: null,
    });
  });

  it('returns the recorded refusal as an outcome, with no dry-run id to render', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ...ack,
          dry_run: { ...dryRun, status: 'refused', renderable: false, refusalReason: 'custom' },
        }),
      ),
    );
    expect(await dispatchDryRun('http://runtime', 'internal', payload)).toMatchObject({
      status: 'recorded',
      outcome: 'refused',
      refusalReason: 'custom',
    });
  });

  it('maps the runtime refusal (409) to refused with its reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ accepted: false, reason: 'content_mismatch' }, { status: 409 }),
        ),
    );
    expect(await dispatchDryRun('http://runtime', 'internal', payload)).toEqual({
      status: 'refused',
      dryRunId: null,
      outcome: null,
      refusalReason: 'content_mismatch',
      error: null,
    });
  });

  it.each([
    {},
    { ...ack, correlation_id: 'other-dry-run' },
    { ...ack, contract_version: 2 },
    { ...ack, dry_run: { ...dryRun, status: 'invented' } },
  ])('never reports a result for ambiguous acknowledgement %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    expect(await dispatchDryRun('http://runtime', 'internal', payload)).toMatchObject({
      status: 'unavailable',
    });
  });

  it('does not turn an upstream 500 into a result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 500 })));
    expect(await dispatchDryRun('http://runtime', 'internal', payload)).toMatchObject({
      status: 'unavailable',
    });
  });

  it('keeps arbitrary error text out of the outcome', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret token in upstream error')));
    const result = await dispatchDryRun('http://runtime', 'internal', payload);
    expect(result.status).toBe('unavailable');
    expect(result.error).not.toContain('secret token');
  });

  it('refuses before any request when the runtime is unconfigured', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await dispatchDryRun(undefined, 'internal', payload)).toMatchObject({
      status: 'unavailable',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
