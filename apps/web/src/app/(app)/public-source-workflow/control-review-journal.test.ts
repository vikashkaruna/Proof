// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { reviewFixture, ids } from './control-review-fixture.test-helper';
import {
  readControlReviewOperations,
  retainControlReviewOperation,
  assertControlReviewOperation,
  clearResolvedControlReviewOperation,
} from './control-review-journal';
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it('retains exact intent across reload and refuses overwrite, wrong actor and corruption', () => {
  const { operation } = reviewFixture();
  retainControlReviewOperation(localStorage, operation);
  expect(readControlReviewOperations(localStorage, ids.tenant, ids.actor)).toEqual([operation]);
  expect(() => retainControlReviewOperation(localStorage, operation)).toThrow();
  expect(readControlReviewOperations(localStorage, ids.tenant, ids.review)).toEqual([]);
  const key = localStorage.key(0)!;
  localStorage.setItem(key, '{');
  expect(() => readControlReviewOperations(localStorage, ids.tenant, ids.actor)).toThrow();
  expect(() => clearResolvedControlReviewOperation(localStorage, operation)).toThrow();
});
it('detects competing immutable operation entries and clears only exact positively resolved intent', () => {
  const { operation, request } = reviewFixture();
  retainControlReviewOperation(localStorage, operation);
  const firstKey = localStorage.key(0)!;
  const other = {
    ...operation,
    requestText: canonicalJson({ ...request, operationKey: ids.review }),
  };
  const secondKey = firstKey.replace(ids.operation, ids.review);
  localStorage.setItem(secondKey, canonicalJson(other));
  expect(readControlReviewOperations(localStorage, ids.tenant, ids.actor)).toHaveLength(2);
  assertControlReviewOperation(localStorage, operation);
  clearResolvedControlReviewOperation(localStorage, operation);
  expect(readControlReviewOperations(localStorage, ids.tenant, ids.actor)).toEqual([other]);
});
it('refuses noncanonical, wrong-key and oversized retained entries without deleting anything', () => {
  const { operation } = reviewFixture();
  retainControlReviewOperation(localStorage, operation);
  const key = localStorage.key(0)!;
  for (const raw of [
    JSON.stringify(operation),
    'x'.repeat(270000),
    canonicalJson({ ...operation, actorId: ids.review }),
  ]) {
    localStorage.setItem(key, raw);
    expect(() => readControlReviewOperations(localStorage, ids.tenant, ids.actor)).toThrow();
    expect(localStorage.getItem(key)).toBe(raw);
  }
});
it('refuses a failed write/readback and observed concurrent new intent before dispatch', () => {
  const { operation, request } = reviewFixture();
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    original.call(this, key, value);
    original.call(
      this,
      key.replace(ids.operation, ids.review),
      canonicalJson({
        ...operation,
        requestText: canonicalJson({ ...request, operationKey: ids.review }),
      }),
    );
  });
  expect(() => retainControlReviewOperation(localStorage, operation)).toThrow(/Concurrent/);
  expect(localStorage.length).toBe(2);
});
