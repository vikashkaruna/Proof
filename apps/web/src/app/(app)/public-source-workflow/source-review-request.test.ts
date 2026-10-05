// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  reviewOperationSchema,
  reviewStorageKey,
  saveReviewOperation,
  loadReviewOperation,
  clearReviewOperation,
  recordReviewRefusal,
  dispatchReviewRequest,
  ReviewRequestError,
} from './source-review-request';
const id = '11111111-1111-4111-8111-111111111111';
const body = {
  engagementId: id,
  expectedOutputSha256: 'a'.repeat(64),
  expectedProjectionSha256: 'b'.repeat(64),
  target: { kind: 'whole_observation' },
  decision: 'acknowledged',
  justification: '  Saved HTML attributes reviewed.  ',
  expectedPreviousReviewId: null,
};
const op = {
  version: 1,
  tenantId: id,
  actorId: id,
  operationKey: id,
  bindingId: id,
  observationId: id,
  checkId: id,
  engagementId: id,
  agent: 'drishti',
  rootSha256: 'c'.repeat(64),
  outputSha256: body.expectedOutputSha256,
  projectionSha256: body.expectedProjectionSha256,
  bodyUtf8: JSON.stringify(body),
};
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('preserves exact raw notes, body and key across reload in a separate review journal', () => {
  const operation = reviewOperationSchema.parse(op);
  saveReviewOperation(localStorage, operation);
  expect(loadReviewOperation(localStorage, id, id)).toEqual(operation);
  expect(reviewStorageKey(id, id)).not.toContain('operation.v1');
  expect(JSON.parse(operation.bodyUtf8).justification).toBe(body.justification);
  expect(loadReviewOperation(localStorage, id, '22222222-2222-4222-8222-222222222222')).toBeNull();
});
it.each(['output', 'projection', 'engagement', 'actor', 'bytes', 'target'])(
  'rejects corrupt review operation %s',
  (field) => {
    const invalid = structuredClone(op);
    if (field === 'output') invalid.outputSha256 = 'd'.repeat(64);
    if (field === 'projection') invalid.projectionSha256 = 'd'.repeat(64);
    if (field === 'engagement') invalid.engagementId = '22222222-2222-4222-8222-222222222222';
    if (field === 'actor') invalid.actorId = 'owner';
    if (field === 'bytes') invalid.bodyUtf8 = ' ' + invalid.bodyUtf8;
    if (field === 'target')
      invalid.bodyUtf8 = JSON.stringify({
        ...body,
        target: {
          kind: 'vibhaag_indicator',
          page: 'contact',
          formOrdinal: 1,
          controlOrdinal: 2,
          expectedContentSha256: 'd'.repeat(64),
        },
      });
    expect(reviewOperationSchema.safeParse(invalid).success).toBe(false);
  },
);
it('refuses overwrite of another retained review before a different result can submit', () => {
  const operation = reviewOperationSchema.parse(op);
  saveReviewOperation(localStorage, operation);
  expect(() =>
    saveReviewOperation(localStorage, {
      ...operation,
      observationId: '22222222-2222-4222-8222-222222222222',
    }),
  ).toThrow();
  expect(loadReviewOperation(localStorage, id, id)).toEqual(operation);
});
it('rejects changed journal acknowledgements before dispatch', () => {
  const operation = reviewOperationSchema.parse(op);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
  expect(() => saveReviewOperation(localStorage, operation)).toThrow();
});
it('keeps bytes/key fixed on explicit attempts and classifies only exact known409 refusal codes', async () => {
  const operation = reviewOperationSchema.parse(op);
  saveReviewOperation(localStorage, operation);
  const fetcher = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(Response.json({ error: { code: 'stale_review' } }, { status: 409 })),
    );
  vi.stubGlobal('fetch', fetcher);
  for (let i = 0; i < 2; i++)
    await expect(dispatchReviewRequest(localStorage, operation)).rejects.toMatchObject({
      refusalCode: 'stale_review',
    });
  for (const [url, init] of fetcher.mock.calls) {
    expect(url).toContain(`/public-source-bindings/${id}/observations/${id}/reviews`);
    expect(init.body).toBe(operation.bodyUtf8);
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe(operation.operationKey);
  }
  recordReviewRefusal(localStorage, operation, 'stale_review');
  expect(loadReviewOperation(localStorage, id, id)?.refusalCode).toBe('stale_review');
});
it.each([
  [503, 'stale_review'],
  [409, 'idempotency_conflict'],
  [409, 'public_source_review_unavailable'],
  [409, 'invalid_request'],
  [409, 'target_refused'],
  [404, 'stale_review'],
])('holds ambiguous failure %s/%s without enabling discard', async (status, code) => {
  const operation = reviewOperationSchema.parse(op);
  saveReviewOperation(localStorage, operation);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ error: { code } }, { status: Number(status) })),
  );
  let failure;
  try {
    await dispatchReviewRequest(localStorage, operation);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ReviewRequestError);
  expect((failure as ReviewRequestError).refusalCode).toBeUndefined();
  expect(loadReviewOperation(localStorage, id, id)).toEqual(operation);
});
it('never sends a changed or missing scoped journal operation', async () => {
  const operation = reviewOperationSchema.parse(op);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(dispatchReviewRequest(localStorage, operation)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('refuses clearing a replaced operation', () => {
  const operation = reviewOperationSchema.parse(op);
  saveReviewOperation(localStorage, operation);
  localStorage.setItem(
    reviewStorageKey(id, id),
    JSON.stringify({ ...operation, operationKey: '22222222-2222-4222-8222-222222222222' }),
  );
  expect(() => clearReviewOperation(localStorage, operation)).toThrow();
});

it('classifies target_refused404 as a definite original refusal, not a generic404', async () => {
  const operation = reviewOperationSchema.parse(op);
  saveReviewOperation(localStorage, operation);
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(Response.json({ error: { code: 'target_refused' } }, { status: 404 })),
  );
  await expect(dispatchReviewRequest(localStorage, operation)).rejects.toMatchObject({
    refusalCode: 'target_refused',
  });
});

it('holds network and malformed strict refusals without clearing the durable original intent', async () => {
  const operation = reviewOperationSchema.parse(op);
  saveReviewOperation(localStorage, operation);
  for (const response of [
    new Error('network'),
    Response.json({ error: { code: 'stale_review', message: 'untrusted extra' } }, { status: 409 }),
    Response.json({ error: { code: 'digest_mismatch' } }, { status: 404 }),
    new Response('broken', { status: 409 }),
  ]) {
    vi.stubGlobal(
      'fetch',
      response instanceof Error
        ? vi.fn().mockRejectedValue(response)
        : vi.fn().mockResolvedValue(response),
    );
    await expect(dispatchReviewRequest(localStorage, operation)).rejects.toMatchObject({
      refusalCode: undefined,
    });
    expect(loadReviewOperation(localStorage, id, id)).toEqual(operation);
  }
});
it('refuses dispatch with changed bytes, replaced actor scope or refusal journal context', async () => {
  const operation = reviewOperationSchema.parse(op);
  saveReviewOperation(localStorage, operation);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(
    dispatchReviewRequest(localStorage, {
      ...operation,
      operationKey: '22222222-2222-4222-8222-222222222222',
    }),
  ).rejects.toThrow();
  expect(() =>
    recordReviewRefusal(
      localStorage,
      { ...operation, operationKey: '22222222-2222-4222-8222-222222222222' },
      'stale_review',
    ),
  ).toThrow();
  localStorage.setItem(
    reviewStorageKey(id, id),
    JSON.stringify({ ...operation, actorId: '22222222-2222-4222-8222-222222222222' }),
  );
  expect(() => loadReviewOperation(localStorage, id, id)).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('refuses state unlock when storage fails to remove the retained operation', () => {
  const operation = reviewOperationSchema.parse(op);
  saveReviewOperation(localStorage, operation);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {});
  expect(() => clearReviewOperation(localStorage, operation)).toThrow();
  expect(loadReviewOperation(localStorage, id, id)).toEqual(operation);
});
