import { describe, expect, it } from 'vitest';
import {
  publicSourceCursorSchema,
  publicSourceReadQuerySchema,
  publicSourceRequestKeySchema,
  publicSourceEngagementChoiceSchema,
  publicSourceObservationMetadataSchema,
  publicSourceRequestStateSchema,
  publicSourceEngagementOptionsResponseSchema,
  publicSourceObservationHistoryResponseSchema,
  publicSourceRequestReconciliationResponseSchema,
} from './public-source-reads';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const timestamp = '2026-10-04T12:00:00.123456Z';
const choice = {
  id,
  tenant_id: id,
  title: 'Actual engagement',
  status: 'intake',
  library_version: '0.1',
  created_at: timestamp,
  estate: null,
};
const observation = {
  observation_id: id,
  dispatch_id: id,
  run_id: id,
  tenant_id: id,
  engagement_id: id,
  binding_id: id,
  agent: 'drishti',
  output_sha256: 'a'.repeat(64),
  completion_receipt: '9223372036854775807',
  created_at: timestamp,
};
const context = {
  tenant_id: id,
  actor_id: id,
  engagement_id: id,
  binding_id: id,
  agent: 'drishti',
  correlation_id: id,
};
describe('public source read contracts', () => {
  it('uses strict bounded queries and microsecond cursor precision', () => {
    expect(publicSourceReadQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(publicSourceReadQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
    expect(publicSourceCursorSchema.parse({ created_at: timestamp, id: id.toUpperCase() })).toEqual(
      { created_at: timestamp, id },
    );
  });
  it.each(['0', '51', '01', '1.5', '1e1', '-1', '', 'Infinity'])(
    'refuses malformed limit %s',
    (limit) => {
      expect(publicSourceReadQuerySchema.safeParse({ limit }).success).toBe(false);
    },
  );
  it.each([{ limit: 10 }, { tenantId: id }, { cursor: '' }, { cursor: 'a/b+' }])(
    'refuses malformed query %j',
    (value) => {
      expect(publicSourceReadQuerySchema.safeParse(value).success).toBe(false);
    },
  );
  it.each(['', 'bad-date', '2026-10-04T12:00:00.1234567Z'])(
    'refuses invalid cursor timestamp %s',
    (created_at) => {
      expect(publicSourceCursorSchema.safeParse({ created_at, id }).success).toBe(false);
    },
  );
  it('preserves an unassigned estate without inventing one', () => {
    expect(publicSourceEngagementChoiceSchema.parse(choice).estate).toBeNull();
    expect(
      publicSourceEngagementChoiceSchema.safeParse({
        ...choice,
        estate: { id, name: 'Confirmed estate' },
      }).success,
    ).toBe(true);
  });
  it.each([
    { ...choice, status: 'cancelled' },
    { ...choice, title: '' },
    { ...choice, estate: { id } },
    { ...choice, estate: { id, name: 'X', region: 'Mumbai' } },
    { ...choice, private_system: 'invented' },
  ])('refuses poisoned choice %j', (value) => {
    expect(publicSourceEngagementChoiceSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    '',
    'abc',
    '0',
    '-1',
    '0001',
    '9223372036854775808',
    '99999999999999999999999999999999999999999999999999',
  ])('refuses receipt safely without throwing %s', (completion_receipt) => {
    expect(() =>
      publicSourceObservationMetadataSchema.safeParse({ ...observation, completion_receipt }),
    ).not.toThrow();
    expect(
      publicSourceObservationMetadataSchema.safeParse({ ...observation, completion_receipt })
        .success,
    ).toBe(false);
  });
  it('parses metadata but refuses invented output or unsupported agent', () => {
    expect(publicSourceObservationMetadataSchema.parse(observation)).toEqual(observation);
    expect(
      publicSourceObservationMetadataSchema.safeParse({ ...observation, output: {} }).success,
    ).toBe(false);
    expect(
      publicSourceObservationMetadataSchema.safeParse({ ...observation, agent: 'karya' }).success,
    ).toBe(false);
  });
  it.each(['short', 'x'.repeat(257), 'with\nnewline', 'é'.repeat(10)])(
    'refuses unbounded or invalid request keys',
    (value) => {
      expect(publicSourceRequestKeySchema.safeParse(value).success).toBe(false);
    },
  );
  it('allows each actual outcome while keeping unknown free of fake completion proofs', () => {
    const outcomes = [
      { state: 'not_found' },
      { state: 'unknown', run_id: id },
      { state: 'unknown', run_id: id, dispatch_id: id },
      { state: 'running', run_id: id, dispatch_id: id },
      {
        state: 'confirmed_failed',
        run_id: id,
        dispatch_id: id,
        settlement_receipt: '42',
        error_code: 'agent_reported_failure',
      },
      {
        state: 'completed_without_observation',
        run_id: id,
        dispatch_id: id,
        output_sha256: 'a'.repeat(64),
        completion_receipt: '42',
      },
      { state: 'retained', observation },
    ];
    for (const outcome of outcomes)
      expect(publicSourceRequestStateSchema.safeParse({ ...context, outcome }).success).toBe(true);
    expect(
      publicSourceRequestStateSchema.safeParse({
        ...context,
        outcome: { state: 'unknown', run_id: id, output_sha256: 'a'.repeat(64) },
      }).success,
    ).toBe(false);
    expect(
      publicSourceRequestStateSchema.safeParse({
        ...context,
        outcome: { state: 'succeeded', run_id: id },
      }).success,
    ).toBe(false);
  });
  it.each(['tenant_id', 'engagement_id', 'binding_id', 'agent'])(
    'ties retained metadata to its context %s',
    (key) => {
      expect(
        publicSourceRequestStateSchema.safeParse({
          ...context,
          outcome: {
            state: 'retained',
            observation: { ...observation, [key]: key === 'agent' ? 'vibhaag' : other },
          },
        }).success,
      ).toBe(false);
    },
  );
  it('shares browser response parsers', () => {
    const meta = { limit: 20, hasMore: false, nextCursor: null };
    expect(
      publicSourceEngagementOptionsResponseSchema.safeParse({ data: [choice], meta }).success,
    ).toBe(true);
    expect(
      publicSourceObservationHistoryResponseSchema.safeParse({ data: [observation], meta }).success,
    ).toBe(true);
    expect(
      publicSourceRequestReconciliationResponseSchema.safeParse({
        data: { ...context, outcome: { state: 'not_found' } },
      }).success,
    ).toBe(true);
  });
});
