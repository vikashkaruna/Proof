import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assessmentMetrics, readAssessmentBases } from './assessment-basis';
const tenant = '11111111-1111-4111-8111-111111111111';
const engagement = '22222222-2222-4222-8222-222222222222';
const ordinary = () => ({
  tenant_id: tenant,
  engagement_id: engagement,
  agent: 'parikshan',
  status: 'succeeded',
  output_redacted_hash: 'a'.repeat(64),
  completed_at: '2026-10-19T00:00:00Z',
  metadata: { request_kind: 'questionnaire_v1' } as Record<string, unknown>,
});
function database(data: unknown, error: unknown = null) {
  const calls: unknown[][] = [];
  const query = {
    select: (value: unknown) => {
      calls.push(['select', value]);
      return query;
    },
    eq: (field: unknown, value: unknown) => {
      calls.push(['eq', field, value]);
      return query;
    },
    in: (field: unknown, value: unknown) => {
      calls.push(['in', field, value]);
      return query;
    },
    limit: (value: unknown) => {
      calls.push(['limit', value]);
      return query;
    },
    abortSignal: async (signal: AbortSignal) => {
      calls.push(['signal', signal]);
      return { data, error };
    },
  };
  const from = vi.fn(() => query);
  return { db: { from } as unknown as Pick<SupabaseClient, 'from'>, from, calls };
}
async function basis(rows: unknown, error: unknown = null) {
  const { db } = database(rows, error);
  return (await readAssessmentBases(db, tenant, [engagement])).get(engagement);
}
describe('trusted assessment provenance', () => {
  it('preserves known completed legacy assessments with tenant and deadline bounded reads', async () => {
    const { db, calls, from } = database([ordinary()]);
    expect((await readAssessmentBases(db, tenant, [engagement])).get(engagement)).toBe(
      'recorded_assessment',
    );
    expect(from).toHaveBeenCalledWith('agent_runs');
    expect(calls).toContainEqual(['eq', 'tenant_id', tenant]);
    expect(calls).toContainEqual(['eq', 'agent', 'parikshan']);
    expect(calls).toContainEqual(['in', 'engagement_id', [engagement]]);
    expect(calls).toContainEqual(['limit', 1001]);
    expect(calls.some((call) => call[0] === 'signal' && call[1] instanceof AbortSignal)).toBe(true);
    expect(await basis([{ ...ordinary(), metadata: {} }])).toBe('recorded_assessment');
    expect(
      await basis([{ ...ordinary(), metadata: { request_kind: 'public_control_review_set_v1' } }]),
    ).toBe('recorded_assessment');
  });
  it('withholds scheduled technical provenance regardless of status or row order', async () => {
    const scheduled = {
      ...ordinary(),
      status: 'queued',
      completed_at: null,
      output_redacted_hash: null,
      metadata: { request_kind: 'scheduled_coverage_reassessment_v1' },
    };
    for (const rows of [[scheduled], [ordinary(), scheduled], [scheduled, ordinary()]])
      expect(await basis(rows)).toBe('scheduled_coverage');
  });
  it('fails closed for missing, incomplete, unknown, foreign, malformed, errored and truncated provenance', async () => {
    for (const rows of [
      [],
      null,
      [{ ...ordinary(), status: 'running' }],
      [{ ...ordinary(), completed_at: null }],
      [{ ...ordinary(), output_redacted_hash: null }],
      [{ ...ordinary(), metadata: { request_kind: 'future_unknown' } }, ordinary()],
      [{ ...ordinary(), tenant_id: engagement }],
      [{ ...ordinary(), engagement_id: tenant }],
      [{ ...ordinary(), agent: 'drishti' }],
      [{ ...ordinary(), unexpected: true }],
      Array.from({ length: 1001 }, ordinary),
    ])
      expect(await basis(rows)).toBe('unavailable');
    expect(await basis([ordinary()], new Error('offline'))).toBe('unavailable');
  });
  it('does not read invalid or unbounded scope', async () => {
    const { db, from } = database([ordinary()]);
    await readAssessmentBases(db, 'invalid', [engagement]);
    await readAssessmentBases(db, tenant, ['invalid']);
    await readAssessmentBases(db, tenant, []);
    await readAssessmentBases(
      db,
      tenant,
      Array.from(
        { length: 101 },
        (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
      ),
    );
    expect(from).not.toHaveBeenCalled();
  });
});
it('exposes numeric calculations only for a known ordinary assessment and bounded finite values', () => {
  for (const source of ['scheduled_coverage', 'unavailable', undefined] as const)
    expect(assessmentMetrics(source, 83, 1234567)).toEqual({ score: null, exposureInr: null });
  expect(assessmentMetrics('recorded_assessment', 83, 1234567)).toEqual({
    score: 83,
    exposureInr: 1234567,
  });
  for (const value of [NaN, Infinity, -1, 101, '83', null])
    expect(assessmentMetrics('recorded_assessment', value, 0).score).toBeNull();
  for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null])
    expect(assessmentMetrics('recorded_assessment', 0, value).exposureInr).toBeNull();
});
