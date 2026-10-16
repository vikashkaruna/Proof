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

it('verifies a cancellation of this exact operation and refuses substituted cancellation bytes', async () => {
  const f = reviewFixture();
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
  await expect(sendHumanControlReview(localStorage, f.operation, snapshot.reason)).rejects.toThrow(
    'confirmed cancellation reason',
  );
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
});

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
