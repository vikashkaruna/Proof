// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OwnedEffectObservation } from './owned-effect-observation';
vi.mock('@axiom/ui', () => ({ formatDateTime: (v: string) => v }));
const id = (n: number) => `89170000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const props = { tenantId: id(1), actorId: id(2), planId: id(4), actionId: id(5), batchId: id(6) };
const storageKey = `axiom:owned-effect:${props.tenantId}:${props.actorId}:${props.planId}:${props.actionId}:${props.batchId}`;
const request = { operationKey: id(3), planId: id(4), actionId: id(5), batchId: id(6) };
function receipt() {
  return {
    ...request,
    tenantId: id(1),
    actorId: id(2),
    bindingId: id(7),
    contentDigest: 'a'.repeat(64),
    ledgerReceipt: '123',
    observation: {
      outcome: 'unknown',
      observedAt: '2026-10-19T00:00:00+00:00',
      forwardOperationId: id(10),
      rollbackOperationId: id(11),
      forward: null,
      rollback: null,
      current: { fixture_id: id(8), resource_id: id(9), version: 0, audit_log_enabled: false },
      currentMatchesLastCommit: null,
      recordedActionStatus: 'failed',
      recordedBatchStatus: 'partial_failure',
      approvalExpired: true,
      approvalRevoked: false,
      retryAllowed: false,
      rollbackAllowed: false,
      executionStatusChanged: false,
    },
  };
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', { randomUUID: () => id(3) });
  vi.stubGlobal('navigator', {
    locks: { request: async (_: string, fn: () => Promise<void>) => fn() },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('durably records scope before requesting a readback and presents structured unknown facts', async () => {
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
      ...props,
      request,
      receipt: null,
      planId: undefined,
      actionId: undefined,
      batchId: undefined,
    });
    expect(JSON.parse(String(init.body))).toEqual(request);
    expect(init.headers).toMatchObject({ 'X-Expected-Actor-Id': id(2), 'Idempotency-Key': id(3) });
    return Response.json(receipt());
  });
  vi.stubGlobal('fetch', fetcher);
  render(<OwnedEffectObservation {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record target readback' }));
  await waitFor(() => expect(screen.getByText(/Still unknown:/)).toBeTruthy());
  expect(screen.getByText(/Absence is not proof/)).toBeTruthy();
  expect(screen.getByText('failed / partial_failure')).toBeTruthy();
  expect(screen.getByText('Audit receipt')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(storageKey)!).receipt.ledgerReceipt).toBe('123');
});
it('recovers a lost reply after reload with the same key and exact request', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(Error('reply lost'))
    .mockResolvedValueOnce(Response.json(receipt()));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<OwnedEffectObservation {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record target readback' }));
  await screen.findByRole('alert');
  const frozen = localStorage.getItem(storageKey);
  view.unmount();
  render(<OwnedEffectObservation {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Recover original observation' }));
  await screen.findByText(/Still unknown:/);
  expect(fetcher.mock.calls.map((call) => call[1].body)).toEqual([
    JSON.stringify(request),
    JSON.stringify(request),
  ]);
  expect(JSON.parse(frozen!).request.operationKey).toBe(id(3));
});
it('does not contact the source when durable storage or exclusive coordination is unavailable', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('storage unavailable');
  });
  render(<OwnedEffectObservation {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record target readback' }));
  await screen.findByRole('alert');
  expect(fetcher).not.toHaveBeenCalled();
});
it('refuses a receipt for another action and retains the original pending intent', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...receipt(), actionId: id(99) })),
  );
  render(<OwnedEffectObservation {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record target readback' }));
  await screen.findByRole('alert');
  expect(JSON.parse(localStorage.getItem(storageKey)!).receipt).toBeNull();
  expect(screen.queryByText('Audit receipt')).toBeNull();
});
it('rejects tampered actor storage before transport instead of silently replacing it', async () => {
  localStorage.setItem(
    storageKey,
    JSON.stringify({ tenantId: id(1), actorId: id(99), request, receipt: null }),
  );
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<OwnedEffectObservation {...props} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(storageKey)!).actorId).toBe(id(99));
});
it('rechecks another tab receipt inside the lock and avoids a second observation', async () => {
  localStorage.setItem(
    storageKey,
    JSON.stringify({ tenantId: id(1), actorId: id(2), request, receipt: null }),
  );
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<OwnedEffectObservation {...props} />);
  await screen.findByRole('button', { name: 'Recover original observation' });
  localStorage.setItem(
    storageKey,
    JSON.stringify({ tenantId: id(1), actorId: id(2), request, receipt: receipt() }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Recover original observation' }));
  await screen.findByText(/Still unknown:/);
  expect(fetcher).not.toHaveBeenCalled();
});

it('refuses transport without exclusive browser coordination', async () => {
  vi.stubGlobal('navigator', {});
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<OwnedEffectObservation {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record target readback' }));
  await screen.findByRole('alert');
  expect(fetcher).not.toHaveBeenCalled();
  expect(localStorage.getItem(storageKey)).toBeNull();
});
it('retains the original key when a received receipt cannot be stored', async () => {
  const original = Storage.prototype.setItem;
  let writes = 0;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (++writes === 2) throw Error('receipt storage failed');
    original.call(this, key, value);
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(receipt())),
  );
  render(<OwnedEffectObservation {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record target readback' }));
  await screen.findByRole('alert');
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ request, receipt: null });
  expect(screen.queryByText('Audit receipt')).toBeNull();
});
it('bounds streamed receipt size without accepting a partial response', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('x'.repeat(32769))),
  );
  render(<OwnedEffectObservation {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record target readback' }));
  await screen.findByRole('alert');
  expect(JSON.parse(localStorage.getItem(storageKey)!).receipt).toBeNull();
});
it('shows historical commit and current version drift without claiming execution success', async () => {
  const r = receipt();
  const before = r.observation.current;
  const after = { ...before, version: 1, audit_log_enabled: true };
  const restored = { ...before, version: 2 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...r,
        observation: {
          ...r.observation,
          outcome: 'rollback_committed',
          forward: { before, after },
          rollback: { before: after, after: restored },
          current: { ...restored, version: 4 },
          currentMatchesLastCommit: false,
        },
      }),
    ),
  );
  render(<OwnedEffectObservation {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record target readback' }));
  await screen.findByText('The target recorded the rollback.');
  expect(screen.getByText(/current version differs/)).toBeTruthy();
  expect(screen.getByText('failed / partial_failure')).toBeTruthy();
});
it('starts a fresh observation only after explicit action on a confirmed receipt', async () => {
  localStorage.setItem(
    storageKey,
    JSON.stringify({ tenantId: id(1), actorId: id(2), request, receipt: receipt() }),
  );
  vi.stubGlobal('crypto', { randomUUID: () => id(30) });
  const fetcher = vi.fn(async () => Response.json({ ...receipt(), operationKey: id(30) }));
  vi.stubGlobal('fetch', fetcher);
  render(<OwnedEffectObservation {...props} />);
  await screen.findByText(/Still unknown:/);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Record a fresh observation' }));
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem(storageKey)!).receipt?.operationKey).toBe(id(30)),
  );
  expect(fetcher).toHaveBeenCalledOnce();
});
