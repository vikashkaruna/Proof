import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AssessmentConfirmation } from './assessment-confirmation.js';
const id = (n: number) => `55550000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const expected = {
  tenantId: id(1),
  runId: id(2),
  engagementId: id(3),
  correlationId: id(4),
  inputHash: 'a'.repeat(64),
};
const confirmed = {
  tenant_id: id(1),
  run_id: id(2),
  engagement_id: id(3),
  correlation_id: id(4),
  input_hash: expected.inputHash,
  agent: 'parikshan',
  status: 'succeeded',
  result_digest: 'b'.repeat(64),
  completed_at: '2026-09-22T00:00:00+00:00',
  completed_receipt: '2',
  finalized_receipt: '3',
  result: {
    library_version: 'test',
    posture_score: 0,
    estimated_exposure_inr: 1000000,
    findings: [{ control_id: 'test', score: 0, risk_points: 1, rationale: 'Synthetic' }],
  },
};
function fixture(reply: unknown = confirmed, code = 200) {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(reply), {
        status: code,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const db = createClient('https://db.test.invalid', 'synthetic-service-key', {
    global: { fetch: fetcher },
    auth: { persistSession: false },
  });
  return { fetcher, confirmation: new AssessmentConfirmation(db) };
}
describe('controller assessment confirmation', () => {
  it('confirms independently persisted result using expected controller context, without any worker proof', async () => {
    const f = fixture();
    expect(await f.confirmation.confirm(expected)).toEqual(confirmed);
    expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body))).toEqual({
      p_tenant_id: id(1),
      p_run_id: id(2),
    });
  });
  it.each(['tenant_id', 'run_id', 'engagement_id', 'correlation_id'] as const)(
    'refuses a conflicting %s from the persistence boundary',
    async (key) => {
      await expect(
        fixture({ ...confirmed, [key]: id(9) }).confirmation.confirm(expected),
      ).rejects.toThrow('Assessment completion could not be confirmed.');
    },
  );
  it.each([
    null,
    { error: 'result_unconfirmed' },
    { error: 'terminal_conflict' },
    { ...confirmed, input_hash: 'c'.repeat(64) },
    { ...confirmed, status: 'running' },
    { ...confirmed, completed_receipt: '0' },
    { ...confirmed, finalized_receipt: '2' },
    { ...confirmed, result: {} },
  ])('never turns missing/conflicting/malformed persistence into success', async (reply) => {
    await expect(fixture(reply).confirmation.confirm(expected)).rejects.toThrow(
      'Assessment completion could not be confirmed.',
    );
  });
  it('sanitizes database failures and does not try to overwrite run state', async () => {
    const f = fixture({ message: 'private backend detail' }, 500);
    await expect(f.confirmation.confirm(expected)).rejects.toThrow(
      'Assessment completion could not be confirmed.',
    );
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});
