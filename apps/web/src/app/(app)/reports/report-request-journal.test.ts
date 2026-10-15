// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import {
  readReportRequests,
  retainReportRequest,
  assertReportRequest,
  clearConfirmedReportRequest,
  type ReportRequestOperation,
} from './report-request-journal';
const tenantId = '11111111-1111-4111-8111-111111111111',
  actorId = '22222222-2222-4222-8222-222222222222';
const operation: ReportRequestOperation = {
  version: 1,
  tenantId,
  actorId,
  kind: 'board',
  body: {
    engagementId: '33333333-3333-4333-8333-333333333333',
    assessmentRunId: '44444444-4444-4444-8444-444444444444',
    title: 'Exact original',
    operationKey: '55555555-5555-4555-8555-555555555555',
  },
};
const another = (): ReportRequestOperation => ({
  ...operation,
  body: { ...operation.body, operationKey: '66666666-6666-4666-8666-666666666666' },
});
const key = (v: ReportRequestOperation) =>
  `axiom.report-request.operation.v1:${v.tenantId}:${v.actorId}:${v.kind}:${v.body.operationKey}`;
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
it('round trips immutable exact intent and clears only the same positively confirmed entry', () => {
  const retained = retainReportRequest(localStorage, operation);
  expect(retained).not.toBe(operation);
  expect(readReportRequests(localStorage, tenantId, actorId)).toEqual([operation]);
  assertReportRequest(localStorage, retained);
  clearConfirmedReportRequest(localStorage, retained);
  expect(localStorage.length).toBe(0);
});
it('never exposes or clears another actor or tenant operation', () => {
  retainReportRequest(localStorage, operation);
  expect(readReportRequests(localStorage, tenantId, another().body.operationKey)).toEqual([]);
  expect(readReportRequests(localStorage, another().body.operationKey, actorId)).toEqual([]);
  expect(localStorage.getItem(key(operation))).toBe(canonicalJson(operation));
});
it('blocks a new request of either kind while preserving the unresolved original', () => {
  retainReportRequest(localStorage, operation);
  expect(() => retainReportRequest(localStorage, { ...another(), kind: 'auditor' })).toThrow(
    'Resolve',
  );
  expect(readReportRequests(localStorage, tenantId, actorId)).toEqual([operation]);
});
it.each(['malformed', 'noncanonical', 'duplicate', 'wrong-key', 'wrong-tenant', 'oversized'])(
  'refuses %s storage without deleting it',
  (mode) => {
    let name = key(operation),
      raw = canonicalJson(operation);
    if (mode === 'malformed') raw = '[';
    if (mode === 'noncanonical') raw += ' ';
    if (mode === 'duplicate') raw = raw.replace('"version":1', '"version":2,"version":1');
    if (mode === 'wrong-key') name = key(another());
    if (mode === 'wrong-tenant')
      raw = canonicalJson({ ...operation, tenantId: another().body.operationKey });
    if (mode === 'oversized') raw = ' '.repeat(8193);
    localStorage.setItem(name, raw);
    expect(() => readReportRequests(localStorage, tenantId, actorId)).toThrow();
    expect(localStorage.getItem(name)).toBe(raw);
  },
);
it('detects simultaneous independent intents after write without overwriting either', () => {
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    original.call(this, name, value);
    original.call(this, key(another()), canonicalJson(another()));
  });
  expect(() => retainReportRequest(localStorage, operation)).toThrow('Concurrent');
  expect(readReportRequests(localStorage, tenantId, actorId)).toHaveLength(2);
});
it('detects failed write/readback and never supplies a dispatchable intent', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
  expect(() => retainReportRequest(localStorage, operation)).toThrow('Nothing was sent');
  expect(localStorage.length).toBe(0);
});
it('does not clear an entry changed after request dispatch or corrupt sibling', () => {
  retainReportRequest(localStorage, operation);
  localStorage.setItem(
    key(operation),
    canonicalJson({ ...operation, body: { ...operation.body, title: 'Changed' } }),
  );
  expect(() => clearConfirmedReportRequest(localStorage, operation)).toThrow('changed');
  expect(localStorage.length).toBe(1);
  localStorage.setItem(key(operation), canonicalJson(operation));
  localStorage.setItem(key(another()), 'broken');
  expect(() => clearConfirmedReportRequest(localStorage, operation)).toThrow();
  expect(localStorage.length).toBe(2);
});
it('retains a confirmed entry when remove/readback fails, allowing explicit cleanup without new POST', () => {
  retainReportRequest(localStorage, operation);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {});
  expect(() => clearConfirmedReportRequest(localStorage, operation)).toThrow(
    'could not be cleared',
  );
  expect(readReportRequests(localStorage, tenantId, actorId)).toEqual([operation]);
});
it('does not claim cross-tab exclusion when another explicit intent is written after completed cleanup', () => {
  retainReportRequest(localStorage, operation);
  clearConfirmedReportRequest(localStorage, operation);
  retainReportRequest(localStorage, another());
  expect(readReportRequests(localStorage, tenantId, actorId)).toEqual([another()]);
});
