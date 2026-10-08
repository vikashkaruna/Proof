// @vitest-environment jsdom
/** Component simulation only; actual GoTrue/SQL/named acceptance is separate. */
import React from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { OwnedTargetPanel } from './owned-target-panel';
import {
  readOwnedRequestJournal,
  ownedJournalSchema,
  retainOwnedRequestJournal,
} from './owned-target-request';
const id = (n: number) => `89160000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const props = {
  tenantId: id(1),
  actorId: id(2),
  canCreate: true,
  engagements: [{ id: id(3), title: 'Owned fixture engagement' }],
};
const targets = {
  tenantId: id(1),
  actorId: id(2),
  engagementId: id(3),
  targets: [
    {
      bindingId: id(4),
      engagementId: id(3),
      label: 'Owned synthetic audit configuration',
      scope: 'owned_synthetic_config.audit_log_enable',
      auditLogEnabled: false,
      currentVersion: 0,
      snapshotHash: 'a'.repeat(64),
    },
  ],
};
const fetcher = vi.fn();
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('navigator', {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        work: (lock: { name: string; mode: string }) => Promise<unknown>,
      ) => work({ name: 'owned-test-lock', mode: 'exclusive' }),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function selectTarget() {
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(targets), { status: 200 }));
  fireEvent.change(screen.getByLabelText('Engagement'), { target: { value: id(3) } });
  fireEvent.click(screen.getByRole('button', { name: 'Load registered targets' }));
  await screen.findByLabelText('Owned target');
  fireEvent.change(screen.getByLabelText('Owned target'), { target: { value: id(4) } });
  fireEvent.change(screen.getByLabelText('Reason for this new human plan'), {
    target: { value: 'Explicitly enable the owned fixture audit log.' },
  });
  fireEvent.click(screen.getByLabelText('This is the registered owned synthetic target.'));
}
it('does not render owned target controls without dual capability', () => {
  render(<OwnedTargetPanel {...props} canCreate={false} />);
  expect(screen.queryByRole('heading', { name: 'Owned synthetic configuration plan' })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it('loads only bound registered targets and sends expected tenant/actor headers', async () => {
  render(<OwnedTargetPanel {...props} />);
  await selectTarget();
  expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/bff/v1/plans/owned-synthetic/targets/${id(3)}`);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'GET',
    cache: 'no-store',
    headers: { 'X-Tenant-Id': id(1), 'X-Expected-Actor-Id': id(2) },
  });
  expect(screen.queryByLabelText('Website URL')).toBeNull();
});
it('empty registered source is clearly distinguished from unloaded source', async () => {
  render(<OwnedTargetPanel {...props} />);
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ ...targets, targets: [] }), { status: 200 }),
  );
  fireEvent.change(screen.getByLabelText('Engagement'), { target: { value: id(3) } });
  fireEvent.click(screen.getByRole('button', { name: 'Load registered targets' }));
  await screen.findByText('No registered owned targets are available for this engagement.');
  expect(screen.queryByLabelText('Owned target')).toBeNull();
});
it('wrong discovery actor never offers a target', async () => {
  render(<OwnedTargetPanel {...props} />);
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ ...targets, actorId: id(99) }), { status: 200 }),
  );
  fireEvent.change(screen.getByLabelText('Engagement'), { target: { value: id(3) } });
  fireEvent.click(screen.getByRole('button', { name: 'Load registered targets' }));
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Owned target')).toBeNull();
});
it('original body is retained and read back before the actual manual save transport', async () => {
  render(<OwnedTargetPanel {...props} />);
  await selectTarget();
  fetcher.mockImplementationOnce(async (_url: string, options: RequestInit) => {
    const original = readOwnedRequestJournal(localStorage, id(1), id(2));
    expect(original).not.toBeNull();
    expect(options.body).toBe(JSON.stringify(original!.request));
    expect(options.headers).toMatchObject({ 'Idempotency-Key': original!.request.operationKey });
    throw Error('Deliberate response loss');
  });
  fireEvent.click(screen.getByRole('button', { name: 'Measure and create review plan' }));
  await screen.findByRole('alert');
  expect(readOwnedRequestJournal(localStorage, id(1), id(2))).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Recover original outcome' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Archive confirmed browser reference' })).toBeNull();
});
it('refresh retains original request and makes zero automatic writes', async () => {
  const j = ownedJournalSchema.parse({
    version: 1,
    tenantId: id(1),
    actorId: id(2),
    request: {
      operationKey: id(7),
      bindingId: id(4),
      engagementId: id(3),
      expectedSnapshotHash: 'a'.repeat(64),
      reason: 'Explicit owned original plan preserved on refresh.',
      acknowledgeOwnedSynthetic: true,
      actionType: 'config.audit_log_enable',
      desiredEnabled: true,
    },
  });
  retainOwnedRequestJournal(localStorage, j);
  render(<OwnedTargetPanel {...props} />);
  await screen.findByText(j.request.reason);
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Engagement')).toBeNull();
});
it('pending stop recovery makes only read-only outcome request and preserves source when still pending', async () => {
  const j = ownedJournalSchema.parse({
    version: 1,
    tenantId: id(1),
    actorId: id(2),
    request: {
      operationKey: id(7),
      bindingId: id(4),
      engagementId: id(3),
      expectedSnapshotHash: 'a'.repeat(64),
      reason: 'Explicit owned original plan preserved for stop.',
      acknowledgeOwnedSynthetic: true,
      actionType: 'config.audit_log_enable',
      desiredEnabled: true,
    },
    cancellation: {
      cancellationKey: id(8),
      reason: 'Explicitly stop this unrecorded owned request.',
    },
  });
  retainOwnedRequestJournal(localStorage, j);
  render(<OwnedTargetPanel {...props} />);
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ state: 'pending', receipt: null }), { status: 200 }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Recover original outcome' }));
  await screen.findByRole('alert');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/bff/v1/plans/owned-synthetic/outcome');
  expect(readOwnedRequestJournal(localStorage, id(1), id(2))).toEqual(j);
  expect(screen.queryByRole('button', { name: 'Retry original save' })).toBeNull();
});
it('retained malformed source blocks new controls and preserves raw data', async () => {
  localStorage.setItem(`axiom:owned-synthetic-request:v1:${id(1)}:${id(2)}`, '{broken');
  render(<OwnedTargetPanel {...props} />);
  await screen.findByRole('alert');
  expect(localStorage.getItem(`axiom:owned-synthetic-request:v1:${id(1)}:${id(2)}`)).toBe(
    '{broken',
  );
  expect(fetcher).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Load registered targets' }).hasAttribute('disabled'),
    ).toBe(true),
  );
});
