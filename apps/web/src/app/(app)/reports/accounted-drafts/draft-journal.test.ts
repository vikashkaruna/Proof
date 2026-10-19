// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import {
  assertDraftIntent,
  intentKey,
  readDraftJournal,
  retainDraftRequest,
  retainDraftReview,
} from './draft-journal';
const id = '11111111-1111-4111-8111-111111111111';
const request = {
  version: 1 as const,
  kind: 'request' as const,
  tenantId: id,
  actorId: id,
  reviewedRequestText: canonicalJson({
    operationKey: id,
    engagementId: id,
    assessmentRunId: id,
    expectedSourceSha256: 'a'.repeat(64),
    sourceReviewed: true,
  }),
};
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it('requires write/read roundtrip before retaining a request', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
  expect(() => retainDraftRequest(localStorage, request)).toThrow(/Nothing was sent/);
});
it('refuses storage that contains a foreign actor under the local scope', () => {
  localStorage.setItem(
    intentKey(request),
    canonicalJson({ ...request, actorId: '22222222-2222-4222-8222-222222222222' }),
  );
  expect(() => readDraftJournal(localStorage, id, id)).toThrow(/changed scope/);
});
it('does not replace a retained review or accept a changed original request', () => {
  retainDraftRequest(localStorage, request);
  const review = {
    ...request,
    kind: 'review' as const,
    reviewKey: id,
    expectedHash: 'b'.repeat(64),
    decision: 'accepted' as const,
    reason: 'Reviewed all synthetic limitations.',
  };
  retainDraftReview(localStorage, request, review);
  expect(() =>
    retainDraftReview(localStorage, request, { ...review, decision: 'rejected' }),
  ).toThrow(/already retained/);
  localStorage.removeItem(intentKey(request));
  expect(() => assertDraftIntent(localStorage, review)).toThrow(/does not match/);
});
