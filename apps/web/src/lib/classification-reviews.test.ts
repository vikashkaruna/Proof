import type { SupabaseClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import {
  loadClassificationReviewHistory,
  type ClassificationReview,
} from './classification-reviews';

const tenant = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const review: ClassificationReview = {
  id: '33333333-3333-4333-8333-333333333333',
  tenant_id: tenant,
  system_id: 'website-content',
  resource_path: 'contact.email',
  sensitivity_level: 'public',
  detected_categories: ['contact'],
  confidence_score: 0,
  reviewed_by: '44444444-4444-4444-8444-444444444444',
  decision: 'adjusted',
  adjusted_sensitivity: 'internal',
  justification: 'Human review of a declared contact field.',
  created_at: '2026-10-04T10:00:00Z',
};

function database(data: unknown = [], error: unknown = null) {
  const select = vi.fn();
  const eq = vi.fn();
  const order = vi.fn();
  const range = vi.fn();
  const abortSignal = vi.fn();
  const query = {
    select: (columns: string) => {
      select(columns);
      return query;
    },
    eq: (field: string, value: string) => {
      eq(field, value);
      return query;
    },
    order: (field: string, options: unknown) => {
      order(field, options);
      return query;
    },
    range: (start: number, end: number) => {
      range(start, end);
      return query;
    },
    abortSignal: (signal: AbortSignal) => {
      abortSignal(signal);
      return query;
    },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve),
  };
  const from = vi.fn(() => query);
  return {
    client: { from } as unknown as SupabaseClient,
    from,
    select,
    eq,
    order,
    range,
    abortSignal,
  };
}

it('reads the caller-scoped active tenant with a stable bounded projection and preserves declared zero', async () => {
  const db = database([review]);
  expect(await loadClassificationReviewHistory(db.client, tenant)).toEqual({
    state: 'ready',
    reviews: [review],
    page: 1,
    hasNext: false,
  });
  expect(db.from).toHaveBeenCalledWith('classification_reviews');
  expect(db.select).toHaveBeenCalledOnce();
  expect(db.select.mock.calls[0]![0]).not.toContain('*');
  expect(db.eq).toHaveBeenCalledWith('tenant_id', tenant);
  expect(db.order.mock.calls).toEqual([
    ['created_at', { ascending: false }],
    ['id', { ascending: false }],
  ]);
  expect(db.range).toHaveBeenCalledWith(0, 50);
  expect(db.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
});

it('uses a bounded page and extra row only to detect older history', async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({
    ...review,
    id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
    system_id: `system-${i}`,
  }));
  const db = database(rows);
  const loaded = await loadClassificationReviewHistory(db.client, tenant, '2');
  expect(loaded).toEqual({ state: 'ready', reviews: rows.slice(0, 50), page: 2, hasNext: true });
  expect(db.range).toHaveBeenCalledWith(50, 100);
  expect(await loadClassificationReviewHistory(database([]).client, tenant, '1000')).toEqual({
    state: 'ready',
    reviews: [],
    page: 1000,
    hasNext: false,
  });
});

it.each(['0', '-1', '1001', '999999999999999999', '1.5', '1e3', '01', '', ['1', '2']])(
  'rejects invalid page input without querying reviews (%j)',
  async (page) => {
    const db = database();
    expect(await loadClassificationReviewHistory(db.client, tenant, page)).toEqual({
      state: 'invalid_page',
    });
    expect(db.from).not.toHaveBeenCalled();
  },
);

it('refuses a foreign tenant record even if the database query returned it', async () => {
  const db = database([review, { ...review, tenant_id: foreign }]);
  expect(await loadClassificationReviewHistory(db.client, tenant)).toEqual({
    state: 'unavailable',
  });
});

it.each([
  null,
  {},
  [{ ...review, confidence_score: -1 }],
  [{ ...review, confidence_score: '90' }],
  [{ ...review, detected_categories: [] }],
  [{ ...review, decision: 'adjusted', adjusted_sensitivity: null }],
  [{ ...review, decision: 'confirmed', adjusted_sensitivity: 'restricted' }],
  [{ ...review, sensitivity_level: 'verified' }],
  [{ ...review, created_at: 'not-a-date' }],
  Array.from({ length: 52 }, () => review),
])('marks malformed history unavailable (%j)', async (rows) => {
  expect(await loadClassificationReviewHistory(database(rows).client, tenant)).toEqual({
    state: 'unavailable',
  });
});

it('distinguishes query failure from an empty result', async () => {
  expect(await loadClassificationReviewHistory(database([]).client, tenant)).toEqual({
    state: 'ready',
    reviews: [],
    page: 1,
    hasNext: false,
  });
  expect(
    await loadClassificationReviewHistory(
      database([], { message: 'private diagnostic' }).client,
      tenant,
    ),
  ).toEqual({ state: 'unavailable' });
  const db = database();
  db.from.mockImplementation(() => {
    throw new Error('private diagnostic');
  });
  expect(await loadClassificationReviewHistory(db.client, tenant)).toEqual({
    state: 'unavailable',
  });
});

it('accepts category text permitted by the authoritative review contract', async () => {
  const recorded = { ...review, detected_categories: ['x'.repeat(201)] };
  expect(await loadClassificationReviewHistory(database([recorded]).client, tenant)).toEqual({
    state: 'ready',
    reviews: [recorded],
    page: 1,
    hasNext: false,
  });
});
