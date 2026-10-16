// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import { reviewFixture, ids } from './control-review-fixture.test-helper';
import {
  retainControlReviewOperation,
  readControlReviewOperations,
} from './control-review-journal';
import {
  loadHumanControlReview,
  sendHumanControlReview,
  reconcileHumanControlReview,
} from './control-review-client';
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
it('loads only authenticated retained scope and rejects malformed, substituted or incompatible source heads', async () => {
  const f = reviewFixture();
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: f.head }));
  vi.stubGlobal('fetch', fetcher);
  expect(await loadHumanControlReview(f.assessment)).toEqual(f.head);
  expect(fetcher.mock.calls[0]![1].headers).toEqual({ 'X-Tenant-Id': ids.tenant });
  for (const data of [
    { ...f.head, tenantId: ids.actor },
    { ...f.head, expectedSource: { ...f.head.expectedSource, payloadSha256: 'f'.repeat(64) } },
    { ...f.head, unexpected: true },
  ]) {
    fetcher.mockResolvedValue(Response.json({ data }));
    await expect(loadHumanControlReview(f.assessment)).rejects.toThrow();
  }
  fetcher.mockResolvedValue(new Response('{'));
  await expect(loadHumanControlReview(f.assessment)).rejects.toThrow('malformed');
});
it('sends exact retained bytes with actor/tenant/idempotency and verifies the matching positive row', async () => {
  const f = reviewFixture();
  retainControlReviewOperation(localStorage, f.operation);
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      data: { review: f.row, isCurrent: true, contextCurrent: true },
      replayed: false,
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  expect((await sendHumanControlReview(localStorage, f.operation)).state).toBe('recorded');
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    method: 'POST',
    body: f.operation.requestText,
    headers: {
      'X-Tenant-Id': ids.tenant,
      'X-Expected-Actor-Id': ids.actor,
      'Idempotency-Key': ids.operation,
    },
  });
  expect(readControlReviewOperations(localStorage, ids.tenant, ids.actor)).toHaveLength(1);
});
it('rejects wrong actors, request bytes, snapshots and substituted operation receipts', async () => {
  const f = reviewFixture();
  retainControlReviewOperation(localStorage, f.operation);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  for (const data of [
    { ...f.row, actor_id: ids.review },
    { ...f.row, request_text: canonicalJson({ ...f.request, operationKey: ids.review }) },
    { ...f.row, snapshot_text: '{}' },
    { ...f.row, check_id: ids.review },
  ]) {
    fetcher.mockResolvedValue(
      Response.json({ data: { state: 'recorded', data, isCurrent: true, contextCurrent: true } }),
    );
    await expect(reconcileHumanControlReview(f.operation)).rejects.toThrow();
  }
  expect(readControlReviewOperations(localStorage, ids.tenant, ids.actor)).toHaveLength(1);
});
it('not-found, server refusal and interrupted writes never clear an unknown request', async () => {
  const f = reviewFixture();
  retainControlReviewOperation(localStorage, f.operation);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { state: 'not_found' } }));
  vi.stubGlobal('fetch', fetcher);
  expect(await reconcileHumanControlReview(f.operation)).toEqual({ state: 'not_found' });
  fetcher.mockResolvedValue(
    Response.json(
      { error: { code: 'review_actor_changed', message: 'private data' } },
      { status: 409 },
    ),
  );
  await expect(sendHumanControlReview(localStorage, f.operation)).rejects.toThrow(
    'review_actor_changed',
  );
  fetcher.mockRejectedValue(new Error('private transport'));
  await expect(sendHumanControlReview(localStorage, f.operation)).rejects.toThrow('uncertain');
  expect(readControlReviewOperations(localStorage, ids.tenant, ids.actor)).toEqual([f.operation]);
});
it('refuses invalid scoped operations or corrupt storage before any request', async () => {
  const f = reviewFixture();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(reconcileHumanControlReview({ ...f.operation, tenantId: 'bad' })).rejects.toThrow();
  await expect(sendHumanControlReview(localStorage, f.operation)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['v1', 'v2'] as const)(
  'verifies %s exact-operation cancellation and refuses substituted bytes',
  async (version) => {
    const f =
      version === 'v1'
        ? reviewFixture()
        : (await import('./control-review-v2-fixture.test-helper')).linkedReviewFixture();
    retainControlReviewOperation(localStorage, f.operation);
    const snapshot = {
      version: 1,
      tenantId: ids.tenant,
      actorId: ids.actor,
      engagementId: ids.engagement,
      checkId: ids.check,
      operationKey: ids.operation,
      requestSha256: f.row.request_sha256,
      reason: 'Withdraw this unrecorded request.',
    };
    const cancelled = {
      id: ids.review,
      tenant_id: ids.tenant,
      actor_id: ids.actor,
      engagement_id: ids.engagement,
      check_id: ids.check,
      operation_key: ids.operation,
      request_codec: f.row.request_codec,
      request_text: f.row.request_text,
      request_sha256: f.row.request_sha256,
      reason: snapshot.reason,
      cancellation_codec: 'axiom-public-control-review-cancellation-pg-canonical-json-1',
      cancellation_text: canonicalJson(snapshot),
      cancellation_sha256: 'e'.repeat(64),
      receipt_id: '45',
      created_at: f.row.created_at,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { state: 'cancelled', data: cancelled } }));
    vi.stubGlobal('fetch', fetcher);
    expect((await sendHumanControlReview(localStorage, f.operation, snapshot.reason)).state).toBe(
      'cancelled',
    );
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
      request: f.request,
      reason: snapshot.reason,
    });
    const differentReason = 'A different recorded cancellation reason.';
    const differentText = canonicalJson({ ...snapshot, reason: differentReason });
    const differentRow = {
      ...cancelled,
      reason: differentReason,
      cancellation_text: differentText,
      cancellation_sha256: createHash('sha256').update(differentText).digest('hex'),
    };
    fetcher.mockImplementation(async () =>
      Response.json({ data: { state: 'cancelled', data: differentRow } }),
    );
    await expect(
      sendHumanControlReview(localStorage, f.operation, snapshot.reason),
    ).rejects.toThrow('confirmed cancellation reason');
    expect((await reconcileHumanControlReview(f.operation)).state).toBe('cancelled');
    fetcher.mockResolvedValue(
      Response.json({
        data: {
          state: 'cancelled',
          data: {
            ...cancelled,
            cancellation_text: canonicalJson({ ...snapshot, reason: 'Substituted' }),
          },
        },
      }),
    );
    await expect(reconcileHumanControlReview(f.operation)).rejects.toThrow('cancellation receipt');
    expect(localStorage.length).toBe(1);
  },
);

it('pins the original retained operation across an awaited response', async () => {
  const f = reviewFixture();
  const operation = { ...f.operation };
  retainControlReviewOperation(localStorage, operation);
  let finish: (value: Response) => void = () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const pending = sendHumanControlReview(localStorage, operation);
  operation.actorId = ids.review;
  operation.requestText = canonicalJson({ ...f.request, operationKey: ids.review });
  finish(
    Response.json({
      data: { review: f.row, isCurrent: true, contextCurrent: true },
      replayed: false,
    }),
  );
  expect((await pending).state).toBe('recorded');
  expect(readControlReviewOperations(localStorage, ids.tenant, ids.actor)).toEqual([f.operation]);
});

it('accepts an explicit v2 frozen association and rejects codec or nested provenance substitution', async () => {
  const { linkedReviewFixture } = await import('./control-review-v2-fixture.test-helper');
  const f = linkedReviewFixture();
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: f.head }));
  vi.stubGlobal('fetch', fetcher);
  expect((await loadHumanControlReview(f.assessment)).review?.snapshot.version).toBe(2);
  for (const change of [
    { ...f.row, request_codec: 'axiom-public-control-review-request-canonical-json-1' },
    { ...f.row, snapshot_codec: 'axiom-public-control-review-snapshot-canonical-json-1' },
    (() => {
      const snapshot = structuredClone(f.row.snapshot);
      snapshot.assetProvenance.system_id = ids.actor;
      return { ...f.row, snapshot, snapshot_text: canonicalJson(snapshot) };
    })(),
    (() => {
      const snapshot = structuredClone(f.row.snapshot);
      snapshot.assetProvenance.association.receipt.id = '99';
      return { ...f.row, snapshot, snapshot_text: canonicalJson(snapshot) };
    })(),
  ]) {
    fetcher.mockResolvedValue(Response.json({ data: { ...f.head, review: change } }));
    await expect(loadHumanControlReview(f.assessment)).rejects.toThrow();
  }
  retainControlReviewOperation(localStorage, f.operation);
  fetcher.mockResolvedValue(
    Response.json({
      data: { review: f.row, isCurrent: true, contextCurrent: true },
      replayed: false,
    }),
  );
  expect((await sendHumanControlReview(localStorage, f.operation)).state).toBe('recorded');
  expect(fetcher.mock.calls.at(-1)?.[1].body).toBe(f.operation.requestText);
});

it('accepts PostgreSQL timezone-equivalent microsecond instants but refuses a one-microsecond difference', async () => {
  const { linkedReviewFixture } = await import('./control-review-v2-fixture.test-helper');
  const f = linkedReviewFixture();
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  function rowAt(checkedAt: string) {
    const snapshot = structuredClone(f.row.snapshot);
    snapshot.checkedAt = checkedAt;
    const association = JSON.parse(snapshot.assetProvenance.association.snapshot_text) as Record<
      string,
      unknown
    >;
    association.checkedAt = '2026-10-16T01:57:13.529152Z';
    snapshot.assetProvenance.association.snapshot_text = canonicalJson(association);
    snapshot.assetProvenance.association.snapshot_sha256 = hash(canonicalJson(association));
    snapshot.request.associationRef.associationSha256 =
      snapshot.assetProvenance.association.snapshot_sha256;
    return {
      ...f.row,
      snapshot,
      request_text: canonicalJson(snapshot.request),
      request_sha256: hash(canonicalJson(snapshot.request)),
      snapshot_text: canonicalJson(snapshot),
      snapshot_sha256: hash(canonicalJson(snapshot)),
    };
  }
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ data: { ...f.head, review: rowAt('2026-10-16T01:57:13.529152+00:00') } }),
    );
  vi.stubGlobal('fetch', fetcher);
  expect((await loadHumanControlReview(f.assessment)).review?.snapshot.version).toBe(2);
  fetcher.mockResolvedValue(
    Response.json({ data: { ...f.head, review: rowAt('2026-10-16T01:57:13.529153+00:00') } }),
  );
  await expect(loadHumanControlReview(f.assessment)).rejects.toThrow('provenance');
});
