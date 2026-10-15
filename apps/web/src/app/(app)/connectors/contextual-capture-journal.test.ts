// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  contextualCaptureStorageKey,
  loadContextualCapture,
  retainContextualCapture,
  clearContextualCapture,
} from './contextual-capture-journal';
const tenantId = '11111111-1111-4111-8111-111111111111',
  actorId = '22222222-2222-4222-8222-222222222222';
const record = {
  tenantId,
  actorId,
  contextId: 'original-engagement/check',
  key: '33333333-3333-4333-8333-333333333333',
  url: 'https://public.org/',
  body: JSON.stringify({ url: 'https://public.org/' }),
};
afterEach(() => localStorage.clear());
it('retains exact original request and refuses conflicting operations or compare-and-clear', () => {
  retainContextualCapture(localStorage, record);
  expect(loadContextualCapture(localStorage, tenantId, actorId)).toEqual(record);
  const other = { ...record, key: '44444444-4444-4444-8444-444444444444' };
  expect(() => retainContextualCapture(localStorage, other)).toThrow();
  expect(() => clearContextualCapture(localStorage, other)).toThrow();
  expect(loadContextualCapture(localStorage, tenantId, actorId)).toEqual(record);
  clearContextualCapture(localStorage, record);
  expect(loadContextualCapture(localStorage, tenantId, actorId)).toBeNull();
});
it.each(['tenantId', 'actorId'] as const)(
  'rejects a wrongly scoped retained %s without deleting it',
  (field) => {
    const key = contextualCaptureStorageKey(tenantId, actorId) + ':' + record.key;
    const text = JSON.stringify({ ...record, [field]: '44444444-4444-4444-8444-444444444444' });
    localStorage.setItem(key, text);
    expect(() => loadContextualCapture(localStorage, tenantId, actorId)).toThrow();
    expect(localStorage.getItem(key)).toBe(text);
  },
);
it.each([
  {},
  { ...record, url: '' },
  { ...record, body: '{"url":"https://other.org/"}' },
  { ...record, url: 'https://secret@public.org/' },
])('rejects malformed saved input', (value) => {
  const key = contextualCaptureStorageKey(tenantId, actorId) + ':' + record.key;
  const text = JSON.stringify(value);
  localStorage.setItem(key, text);
  expect(() => loadContextualCapture(localStorage, tenantId, actorId)).toThrow();
  expect(localStorage.getItem(key)).toBe(text);
});

it('preserves separate uncertain keys from concurrent tabs and clears only one exact entry', () => {
  const second = { ...record, key: '44444444-4444-4444-8444-444444444444' };
  const prefix = contextualCaptureStorageKey(tenantId, actorId) + ':';
  localStorage.setItem(prefix + record.key, JSON.stringify(record));
  localStorage.setItem(prefix + second.key, JSON.stringify(second));
  clearContextualCapture(localStorage, record);
  expect(loadContextualCapture(localStorage, tenantId, actorId)).toEqual(second);
  expect(localStorage.getItem(prefix + second.key)).toBe(JSON.stringify(second));
});
