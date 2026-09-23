import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AssessmentRetention } from './assessment-retention.js';
import { runAssessmentRetention } from '../assessment-retention-worker.js';
const id = (n: number) => `57570000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const purged = {
  status: 'purged',
  tenantId: id(1),
  jobId: id(2),
  receipt: '12',
  purgedAt: '2026-09-23T00:00:00Z',
  retentionDays: 90,
};
function fixture(reply: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(reply), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const db = createClient('https://db.test.invalid', 'synthetic-key', {
    global: { fetch: fetcher },
    auth: { persistSession: false },
  });
  return {
    fetcher,
    retention: new AssessmentRetention(db, { retentionDays: 90, tenantId: id(1) }),
  };
}
describe('private assessment retention', () => {
  it('sends backend policy without a caller-controlled clock', async () => {
    const f = fixture(purged);
    expect(await f.retention.purgeNext()).toEqual(purged);
    expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body))).toEqual({
      p_retention_days: 90,
      p_tenant_id: id(1),
    });
    expect(f.fetcher.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([{ status: 'idle' }, { status: 'review', tenantId: id(1), jobId: id(2) }])(
    'accepts opaque maintenance state',
    async (value) => {
      expect(await fixture(value).retention.purgeNext()).toEqual(value);
    },
  );
  it.each([
    { ...purged, tenantId: id(3) },
    { ...purged, retentionDays: 1 },
    { ...purged, receipt: '0' },
    { ...purged, purgedAt: 'yesterday' },
    { ...purged, ciphertext: 'private-marker' },
    { status: 'idle', proof: 'private-marker' },
    { error: 'private-marker' },
  ])('refuses malformed, foreign and private receipts', async (value) => {
    await expect(fixture(value).retention.purgeNext()).rejects.toThrow(
      'Assessment retention unavailable; inspect durable receipts before retrying.',
    );
  });
  it('sanitizes backend failures', async () => {
    await expect(fixture({ message: 'private-marker' }, 500).retention.purgeNext()).rejects.toThrow(
      'Assessment retention unavailable; inspect durable receipts before retrying.',
    );
  });
  it.each([{ args: [] }, { args: ['--watch', '--once'] }, { args: ['--tenant', id(1)] }])(
    'validates invocation before accessing credentials',
    async ({ args }) => {
      const create = vi.fn();
      await expect(
        runAssessmentRetention(args, { create, report: vi.fn(), wait: vi.fn() }),
      ).rejects.toThrow('Use --once or --watch.');
      expect(create).not.toHaveBeenCalled();
    },
  );
  it('runs exactly one RPC in once mode', async () => {
    const f = fixture(purged),
      report = vi.fn(),
      wait = vi.fn();
    await runAssessmentRetention(['--once'], { create: () => f.retention, report, wait });
    expect(report).toHaveBeenCalledExactlyOnceWith(purged);
    expect(wait).not.toHaveBeenCalled();
  });
  it('stops on review before waiting or retrying', async () => {
    const f = fixture({ status: 'review', tenantId: id(1), jobId: id(2) }),
      wait = vi.fn();
    await expect(
      runAssessmentRetention(['--watch'], { create: () => f.retention, report: vi.fn(), wait }),
    ).rejects.toThrow('requires review');
    expect(wait).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('waits between polls and stops on an uncertain RPC failure', async () => {
    const purgeNext = vi
      .fn()
      .mockResolvedValueOnce({ status: 'idle' })
      .mockRejectedValueOnce(new Error('uncertain'));
    const wait = vi.fn().mockResolvedValue(undefined),
      report = vi.fn();
    await expect(
      runAssessmentRetention(['--watch'], { create: () => ({ purgeNext }), report, wait }),
    ).rejects.toThrow('uncertain');
    expect(wait).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledExactlyOnceWith({ status: 'idle' });
    expect(purgeNext).toHaveBeenCalledTimes(2);
  });
});
