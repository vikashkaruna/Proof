// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeMonitoringReadScope } from '@axiom/types';
import {
  loadReadJournal,
  saveReadJournal,
  confirmReadScope,
  confirmReadPreflight,
  withReadJournalLock,
  type ReadJournal,
} from './read-journal';
const id = (n: number) => `11111111-1111-4111-8111-${n.toString().padStart(12, '0')}`;
const v: ReadJournal = {
  kind: 'scope',
  tenantId: id(1),
  actorId: id(2),
  scheduleId: id(3),
  intent: {
    phase: 'revoke',
    request: {
      schemaVersion: 1,
      operationKey: id(4),
      scopeId: id(5),
      reason: 'Operator cancellation of synthetic enumeration',
    },
  },
};
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => vi.unstubAllGlobals());
async function sha() {
  if (v.kind !== 'scope') throw Error();
  return Buffer.from(
    await webcrypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(encodeMonitoringReadScope(v.intent)),
    ),
  ).toString('hex');
}
it('retains exact actor/tenant intent without a TOTP and blocks another request', () => {
  saveReadJournal(localStorage, v);
  expect(loadReadJournal(localStorage, id(1), id(2))).toEqual(v);
  expect(loadReadJournal(localStorage, id(1), id(9))).toBeNull();
  expect(() => saveReadJournal(localStorage, { ...v, scheduleId: id(9) })).toThrow();
});
it('does not clear an unrecorded operation or a mismatched receipt', async () => {
  saveReadJournal(localStorage, v);
  expect(
    await confirmReadScope(localStorage, v, {
      recorded: false,
      requestSha256: await sha(),
      challengeExpiresAt: null,
      fenced: false,
      fenceReceiptId: null,
    }),
  ).toBe(false);
  await expect(
    confirmReadScope(localStorage, v, {
      recorded: true,
      requestSha256: await sha(),
      scopeId: id(99),
      revoked: true,
      receiptId: '1',
    }),
  ).rejects.toThrow();
  expect(loadReadJournal(localStorage, id(1), id(2))).toEqual(v);
});
it('clears only a matching receipt or authoritative cancellation fence', async () => {
  saveReadJournal(localStorage, v);
  expect(
    await confirmReadScope(localStorage, v, {
      recorded: true,
      requestSha256: await sha(),
      scopeId: id(5),
      revoked: true,
      receiptId: '1',
    }),
  ).toBe(true);
  saveReadJournal(localStorage, v);
  expect(
    await confirmReadScope(localStorage, v, {
      recorded: false,
      requestSha256: await sha(),
      challengeExpiresAt: null,
      fenced: true,
      fenceReceiptId: '2',
    }),
  ).toBe(true);
  expect(loadReadJournal(localStorage, id(1), id(2))).toBeNull();
});
it('preserves malformed storage and rejects TOTP/unknown fields', () => {
  const key = `axiom:scheduled-read:v1:${id(1)}:${id(2)}`;
  localStorage.setItem(key, JSON.stringify({ ...v, code: '123456' }));
  expect(() => loadReadJournal(localStorage, id(1), id(2))).toThrow();
  expect(localStorage.getItem(key)).toContain('123456');
});
it('requires exact completed preflight and independent cleanup', () => {
  const p: ReadJournal = {
    kind: 'preflight',
    tenantId: id(1),
    actorId: id(2),
    scheduleId: id(3),
    operationKey: id(4),
    connectorId: id(6),
    engagementId: id(7),
  };
  saveReadJournal(localStorage, p);
  const result = {
    id: id(4),
    connector_id: id(6),
    engagement_id: id(7),
    status: 'completed',
    expires_at: '2026-10-19T00:00:00Z',
    cleanup_confirmed: false,
  };
  expect(() => confirmReadPreflight(localStorage, p, result)).toThrow();
  expect(() =>
    confirmReadPreflight(localStorage, p, { ...result, cleanup_confirmed: true, id: id(9) }),
  ).toThrow();
  confirmReadPreflight(localStorage, p, { ...result, cleanup_confirmed: true });
  expect(loadReadJournal(localStorage, id(1), id(2))).toBeNull();
});
it('requires browser lock support before any sending callback', async () => {
  const work = vi.fn();
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
  await expect(withReadJournalLock(id(1), id(2), work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
});
