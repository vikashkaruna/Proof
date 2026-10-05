import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearJournal,
  JOURNAL_SAVED,
  notifySavedJournal,
  readJournal,
  retainJournal,
  validateRecorded,
  workflowFetch,
  type Journal,
} from './request';
const tenant = '99111000-0000-4000-8000-000000000001',
  actor = '99111000-0000-4000-8000-000000000002',
  key = '99111000-0000-4000-8000-000000000003';
const journal: Journal = {
  tenantId: tenant,
  actorId: actor,
  request: {
    operationKey: key,
    kind: 'delivery_task',
    payload: {
      engagementId: null,
      taskName: 'Review',
      source: 'Stopwatch',
      durationMinutes: 0,
      repetitions: 2,
      notes: '',
    },
  },
};
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
    removeItem: (k) => {
      values.delete(k);
    },
    clear: () => values.clear(),
    key: (i) => Array.from(values.keys())[i] ?? null,
    get length() {
      return values.size;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('durable browser workflow requests', () => {
  it('notifies sibling forms of a schema-valid confirmed journal only', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const listener = vi.fn();
    target.addEventListener(JOURNAL_SAVED, listener);
    notifySavedJournal(journal);
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual(journal);
    expect(() => notifySavedJournal({ ...journal, actorId: 'invalid' })).toThrow();
    expect(listener).toHaveBeenCalledOnce();
  });
  it('recovers exact bytes only in the same tenant and account', () => {
    const s = storage();
    retainJournal(s, journal);
    expect(readJournal(s, tenant, actor)).toEqual(journal);
    expect(readJournal(s, actor, tenant)).toBeNull();
  });
  it('does not replace an unresolved operation with a new key', () => {
    const s = storage();
    retainJournal(s, journal);
    expect(() =>
      retainJournal(s, { ...journal, request: { ...journal.request, operationKey: actor } }),
    ).toThrow('Resolve');
    expect(readJournal(s, tenant, actor)).toEqual(journal);
  });
  it('detects storage refusing to retain the request', () => {
    const s = storage();
    s.setItem = () => {};
    expect(() => retainJournal(s, journal)).toThrow('Nothing was submitted');
  });
  it('does not clear another pending operation', () => {
    const s = storage();
    retainJournal(s, journal);
    expect(() =>
      clearJournal(s, { ...journal, request: { ...journal.request, operationKey: actor } }),
    ).toThrow('changed');
    expect(readJournal(s, tenant, actor)).toEqual(journal);
  });
  it('refuses foreign tenant, actor, body or operation results', () => {
    const row = {
      id: key,
      tenant_id: tenant,
      operation_key: key,
      created_by: actor,
      created_at: '2026-10-05T00:00:00Z',
      receipt_id: '111',
      content_sha256: null,
      kind: journal.request.kind,
      payload: journal.request.payload,
    };
    expect(validateRecorded(row, tenant, journal.request, actor)).toMatchObject({
      receipt_id: '111',
    });
    for (const patch of [
      { tenant_id: actor },
      { created_by: tenant },
      { operation_key: actor },
      { payload: { ...row.payload, durationMinutes: 3 } },
    ])
      expect(() => validateRecorded({ ...row, ...patch }, tenant, journal.request, actor)).toThrow(
        'does not match',
      );
  });
  it('sends one authenticated same-origin request with the retained key and body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await workflowFetch(tenant, '/operator-workflows/records', journal.request, actor);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/bff/v1/operator-workflows/records');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      body: JSON.stringify(journal.request),
      headers: { 'Idempotency-Key': key, 'X-Tenant-Id': tenant, 'X-Expected-Actor-Id': actor },
    });
  });
  it('does not automatically retry an interrupted write', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('lost'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      workflowFetch(tenant, '/operator-workflows/records', journal.request, actor),
    ).rejects.toThrow('Check the retained');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not send credentials or workflow text to arbitrary paths', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const path of [
      'https://example.invalid',
      '//example.invalid',
      '/operator-workflows/../outsider',
    ])
      await expect(workflowFetch(tenant, path, journal.request, actor)).rejects.toThrow('Invalid');
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('refuses a mutation without the expected retained actor before network access', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    workflowFetch(tenant, '/operator-workflows/records', journal.request),
  ).rejects.toThrow('signed-in account');
  expect(fetch).not.toHaveBeenCalled();
});
