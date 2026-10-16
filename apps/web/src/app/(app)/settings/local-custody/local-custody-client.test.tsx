// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalCustodyClient } from './local-custody-client';
import { readCustodyIntents, retainCustodyIntent, intentFor } from './custody-journal';
import {
  tenant,
  actor,
  event,
  other,
  request,
  receipt,
  context,
  cancellationReceipt,
  manifest,
  policyId,
} from './__tests__/fixtures';
const api = vi.hoisted(() => ({ load: vi.fn(), step: vi.fn(), resolution: vi.fn() }));
vi.mock('./custody-client', () => ({
  custodyScope: (tenantId: string, actorId: string) => ({ tenantId, actorId }),
  loadCustodyContext: api.load,
  custodyStep: api.step,
  custodyResolutionStep: api.resolution,
}));
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  api.load
    .mockReset()
    .mockImplementation(async (scope: { tenantId: string; actorId: string }) =>
      context(scope.tenantId, scope.actorId),
    );
  api.resolution
    .mockReset()
    .mockImplementation(
      async (
        _scope: unknown,
        step: string,
        c: ReturnType<typeof import('./__tests__/fixtures').cancellation>,
      ) =>
        step === 'recover'
          ? { state: 'not_found' }
          : step === 'challenge'
            ? { challengeId: event, expiresAt: new Date(Date.now() + 60000).toISOString() }
            : step === 'verify'
              ? { verified: true, challengeId: event }
              : cancellationReceipt(c),
    );
  api.step
    .mockReset()
    .mockImplementation(async (_scope: unknown, step: string, r: ReturnType<typeof request>) =>
      step === 'recover'
        ? { state: 'not_found' }
        : step === 'challenge'
          ? { challengeId: event, expiresAt: new Date(Date.now() + 60000).toISOString() }
          : step === 'verify'
            ? { verified: true, challengeId: event }
            : receipt(r),
    );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function mount() {
  render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  await screen.findByText('No unresolved request in this organisation and account.');
}
async function prepare() {
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Reviewed dispatch custody only' },
  });
  fireEvent.change(screen.getByLabelText('Operator-reviewed non-secret manifest JSON'), {
    target: { value: JSON.stringify(manifest()) },
  });
  fireEvent.click(
    screen.getByLabelText('I reviewed the exact non-secret policy, selected action and reason.'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Prepare owner request' }));
  await screen.findByRole('button', { name: 'Check retained request' });
}
it('prepares durable exact intent without mutation; requires recovery and fresh confirmation before MFA', async () => {
  await mount();
  await prepare();
  expect(api.step.mock.calls.map((c) => c[1])).toEqual(['recover']);
  expect(readCustodyIntents(localStorage, tenant, actor)).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Request authenticator challenge' })).toHaveProperty(
    'disabled',
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await screen.findByText(/No positive receipt was found/);
  expect(readCustodyIntents(localStorage, tenant, actor)).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Request authenticator challenge' })).toHaveProperty(
    'disabled',
    true,
  );
  fireEvent.click(
    screen.getByLabelText(
      'I reviewed this exact retained request and authorize its retry with fresh MFA.',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Request authenticator challenge' }));
  await screen.findByLabelText('Authenticator code');
  expect(api.step.mock.calls.map((c) => c[1])).toEqual(['recover', 'recover', 'challenge']);
});
it('recorded response loss reload preserves exact body/key; only positive recovery clears', async () => {
  await mount();
  await prepare();
  const saved = readCustodyIntents(localStorage, tenant, actor)[0]!;
  cleanup();
  render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  await screen.findByRole('button', { name: 'Check retained request' });
  api.step.mockClear();
  api.step.mockRejectedValueOnce(Error('Connection lost; outcome unknown'));
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await screen.findByRole('alert');
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([saved]);
  api.step.mockResolvedValueOnce(receipt(saved.request));
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await screen.findByText(/Recorded custody receipt confirmed/);
  expect(screen.getByRole('region', { name: 'Confirmed custody receipt' }).textContent).toContain(
    event,
  );
  expect(api.step.mock.calls[0]?.[2]).toEqual(saved.request);
  expect(api.step.mock.calls[1]?.[2]).toEqual(saved.request);
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([]);
});
it('fresh MFA verification/record uses frozen intent and never persists the code', async () => {
  await mount();
  await prepare();
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await screen.findByText(/No positive receipt was found/);
  fireEvent.click(
    screen.getByLabelText(
      'I reviewed this exact retained request and authorize its retry with fresh MFA.',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Request authenticator challenge' }));
  await screen.findByLabelText('Authenticator code');
  fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } });
  expect(JSON.stringify({ ...localStorage })).not.toContain('123456');
  fireEvent.click(screen.getByRole('button', { name: 'Verify authenticator' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Record exact custody action' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Record exact custody action' }));
  await screen.findByText(/Recorded custody receipt confirmed/);
  expect(api.step.mock.calls.map((c) => c[1])).toEqual([
    'recover',
    'recover',
    'challenge',
    'verify',
    'record',
  ]);
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([]);
});
it('editing manifest/reason clears confirmation; secure RNG failure makes no retained intent or call', async () => {
  await mount();
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Reason' } });
  fireEvent.change(screen.getByLabelText('Operator-reviewed non-secret manifest JSON'), {
    target: { value: JSON.stringify(manifest()) },
  });
  fireEvent.click(
    screen.getByLabelText('I reviewed the exact non-secret policy, selected action and reason.'),
  );
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Changed reason' } });
  expect(
    screen.getByLabelText('I reviewed the exact non-secret policy, selected action and reason.'),
  ).not.toHaveProperty('checked', true);
  fireEvent.click(
    screen.getByLabelText('I reviewed the exact non-secret policy, selected action and reason.'),
  );
  vi.stubGlobal('crypto', undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare owner request' }));
  await screen.findByRole('alert');
  expect(api.step).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});
it('hides foreign scope and ignores a late positive reply after tenant change/unmount', async () => {
  retainCustodyIntent(localStorage, intentFor(tenant, actor, request()));
  let resolve: (v: unknown) => void = () => {};
  api.step.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  await screen.findByRole('button', { name: 'Check retained request' });
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  view.rerender(<LocalCustodyClient tenantId={other} actorId={actor} />);
  await screen.findByText('No unresolved request in this organisation and account.');
  resolve(receipt());
  await waitFor(() => expect(readCustodyIntents(localStorage, tenant, actor)).toHaveLength(1));
  expect(screen.queryByText(/Recorded custody receipt confirmed/)).toBeNull();
  view.unmount();
});
it('corrupt storage blocks new intents and exposes a visible error', async () => {
  localStorage.setItem(`axiom:custody-policy:v1:${tenant}:${actor}:${request().operationKey}`, '{');
  render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  await screen.findByRole('alert');
  expect(api.step).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Prepare owner request' })).toBeNull();
});
it('non-requesting operator sees current policy actions and bounded history, not a manifest request form', async () => {
  const c = context();
  c.canRequest = false;
  c.requestModes = [];
  c.rows = [
    {
      policyId: request().operationKey,
      policyText: manifest().policyText,
      policySha256: manifest().policySha256,
      keyPolicySha256: 'b'.repeat(64),
      head: { eventId: event, state: 'approved', activationEpoch: 0, reviewDueAt: 1 },
      reviewOverdue: true,
      actions: ['activate'],
    },
  ];
  api.load.mockResolvedValue(c);
  render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  await screen.findByRole('button', { name: 'Prepare activate' });
  expect(screen.queryByRole('button', { name: 'Prepare owner request' })).toBeNull();
  expect(screen.getByText(/Dispatch-key custody only/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'View policy history' })).toBeTruthy();
});

it('invalid operator manifest refused by read-only validation never becomes an unresolved intent', async () => {
  await mount();
  api.step.mockRejectedValueOnce(
    Error('Manifest digest or key fingerprint could not be verified.'),
  );
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Review' } });
  fireEvent.change(screen.getByLabelText('Operator-reviewed non-secret manifest JSON'), {
    target: { value: JSON.stringify(manifest()) },
  });
  fireEvent.click(
    screen.getByLabelText('I reviewed the exact non-secret policy, selected action and reason.'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Prepare owner request' }));
  await screen.findByRole('alert');
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([]);
  expect(api.step.mock.calls.map((c) => c[1])).toEqual(['recover']);
  expect(screen.getByRole('alert').textContent).toMatch(/could not be verified/);
});

it('committed record response loss survives reload and exact positive reconciliation without another mutation', async () => {
  await mount();
  await prepare();
  const saved = readCustodyIntents(localStorage, tenant, actor)[0]!;
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await screen.findByText(/No positive receipt was found/);
  fireEvent.click(
    screen.getByLabelText(
      'I reviewed this exact retained request and authorize its retry with fresh MFA.',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Request authenticator challenge' }));
  await screen.findByLabelText('Authenticator code');
  fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '654321' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify authenticator' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Record exact custody action' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
  api.step.mockRejectedValueOnce(Error('Committed response lost'));
  fireEvent.click(screen.getByRole('button', { name: 'Record exact custody action' }));
  await screen.findByText('Committed response lost');
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([saved]);
  cleanup();
  api.step.mockResolvedValueOnce(receipt(saved.request));
  render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  await screen.findByRole('button', { name: 'Check retained request' });
  expect(api.step.mock.calls.filter((c) => c[1] === 'record')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await screen.findByText(/Recorded custody receipt confirmed/);
  expect(api.step.mock.calls.at(-1)?.[2]).toEqual(saved.request);
  expect(api.step.mock.calls.filter((c) => c[1] === 'record')).toHaveLength(1);
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([]);
});
it.each(['edit', 'scope', 'unmount'])(
  'late read-only preparation after %s cannot retain or authorize an intent',
  async (change) => {
    const view = render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
    await screen.findByText('No unresolved request in this organisation and account.');
    let resolve: (v: unknown) => void = () => {};
    api.step.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Initial reason' } });
    fireEvent.change(screen.getByLabelText('Operator-reviewed non-secret manifest JSON'), {
      target: { value: JSON.stringify(manifest()) },
    });
    fireEvent.click(
      screen.getByLabelText('I reviewed the exact non-secret policy, selected action and reason.'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Prepare owner request' }));
    await waitFor(() => expect(api.step).toHaveBeenCalledOnce());
    if (change === 'edit')
      fireEvent.change(screen.getByLabelText('Reason'), {
        target: { value: 'Edited while reading' },
      });
    else if (change === 'scope')
      view.rerender(<LocalCustodyClient tenantId={other} actorId={actor} />);
    else view.unmount();
    resolve({ state: 'not_found' });
    await new Promise((r) => setTimeout(r, 0));
    expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([]);
    expect(readCustodyIntents(localStorage, other, actor)).toEqual([]);
    expect(api.step.mock.calls.map((c) => c[1])).toEqual(['recover']);
  },
);

function policyRow(
  actions: Array<'approve' | 'activate' | 'revoke' | 'review'> = ['review', 'revoke'],
) {
  return {
    policyId,
    policyText: manifest().policyText,
    policySha256: manifest().policySha256,
    keyPolicySha256: 'b'.repeat(64),
    head: { eventId: event, state: 'active' as const, activationEpoch: 1, reviewDueAt: 1 },
    reviewOverdue: true,
    actions,
  };
}
it('prepares an exact review predecessor and new future reminder without changing policy validity', async () => {
  const c = context();
  c.rows = [policyRow()];
  api.load.mockResolvedValue(c);
  render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  await screen.findByRole('button', { name: 'Prepare review' });
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Periodic review performed' },
  });
  fireEvent.change(screen.getByLabelText('Next periodic review (review action only)'), {
    target: { value: '2030-10-16T12:00' },
  });
  fireEvent.click(
    screen.getByLabelText('I reviewed the exact non-secret policy, selected action and reason.'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Prepare review' }));
  await screen.findByRole('button', { name: 'Check retained request' });
  expect(readCustodyIntents(localStorage, tenant, actor)[0]?.request).toMatchObject({
    transition: 'review',
    previousEventId: event,
    nextReviewDueAt: Date.parse('2030-10-16T12:00'),
    policyText: c.rows[0]!.policyText,
  });
});
it('supports bounded list and history navigation using server cursors', async () => {
  const first = context();
  first.rows = [policyRow()];
  first.nextCursor = other;
  api.load.mockResolvedValueOnce(first);
  render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  await screen.findByRole('button', { name: 'Next policy page' });
  fireEvent.click(screen.getByRole('button', { name: 'Next policy page' }));
  await waitFor(() =>
    expect(api.load).toHaveBeenLastCalledWith(
      { tenantId: tenant, actorId: actor },
      { after: other },
    ),
  );
  api.load.mockResolvedValueOnce(first);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current policies' }));
  await screen.findByRole('button', { name: 'View policy history' });
  const selected = {
    ...first,
    selectedPolicyId: policyId,
    nextCursor: null,
    history: [receipt()],
    nextHistoryCursor: '1',
  };
  api.load.mockResolvedValueOnce(selected);
  fireEvent.click(screen.getByRole('button', { name: 'View policy history' }));
  await screen.findByRole('button', { name: 'Older history' });
  fireEvent.click(screen.getByRole('button', { name: 'Older history' }));
  await waitFor(() =>
    expect(api.load).toHaveBeenLastCalledWith(
      { tenantId: tenant, actorId: actor },
      { policyId, beforeReceiptId: '1' },
    ),
  );
});
it('pending recovery remains visible when current policy context is unavailable', async () => {
  retainCustodyIntent(localStorage, intentFor(tenant, actor, request()));
  api.load.mockRejectedValue(Error('Unavailable'));
  api.step.mockResolvedValueOnce(receipt());
  render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  await screen.findByRole('button', { name: 'Check retained request' });
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await screen.findByRole('region', { name: 'Confirmed custody receipt' });
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([]);
  expect(screen.queryByRole('button', { name: 'Prepare owner request' })).toBeNull();
});
it('positive reconciliation invalidates the old head even when its refresh fails', async () => {
  const c = context();
  c.rows = [policyRow(['revoke'])];
  api.load.mockResolvedValue(c);
  retainCustodyIntent(localStorage, intentFor(tenant, actor, request()));
  render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  await screen.findByRole('button', { name: 'Prepare revoke' });
  api.load.mockRejectedValueOnce(Error('Refresh failed'));
  api.step.mockResolvedValueOnce(receipt());
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await screen.findByText(/Receipt confirmed. Current context refresh failed/);
  expect(screen.queryByRole('button', { name: 'Prepare revoke' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Confirmed custody receipt' })).toBeTruthy();
});
it('storage change preserves another tab intent and prevents silent mutation', async () => {
  await mount();
  retainCustodyIntent(localStorage, intentFor(tenant, actor, request()));
  fireEvent(window, new StorageEvent('storage', { storageArea: localStorage, key: 'custody' }));
  await screen.findByRole('button', { name: 'Check retained request' });
  expect(api.step).not.toHaveBeenCalled();
  expect(readCustodyIntents(localStorage, tenant, actor)).toHaveLength(1);
});

it('pins an immutable exact request across read-only preparation', async () => {
  await mount();
  api.step.mockImplementationOnce(
    async (_scope: unknown, _step: unknown, r: ReturnType<typeof request>) => {
      expect(Object.isFrozen(r)).toBe(true);
      return { state: 'not_found' };
    },
  );
  await prepare();
  expect(readCustodyIntents(localStorage, tenant, actor)).toHaveLength(1);
});

it('refuses a profile outside the server-declared current request modes before read or retention', async () => {
  await mount();
  const original = manifest();
  const demo = {
    ...original,
    policyText: JSON.stringify({ ...JSON.parse(original.policyText), mode: 'local_demo' }),
  };
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Explicit request' } });
  fireEvent.change(screen.getByLabelText('Operator-reviewed non-secret manifest JSON'), {
    target: { value: JSON.stringify(demo) },
  });
  fireEvent.click(
    screen.getByLabelText('I reviewed the exact non-secret policy, selected action and reason.'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Prepare owner request' }));
  await screen.findByText(/This policy profile cannot be requested/);
  expect(localStorage.length).toBe(0);
  expect(api.step).not.toHaveBeenCalled();
});

it('resolves stale original through separately retained cancellation after reload, no original retry or auto mutation', async () => {
  retainCustodyIntent(localStorage, intentFor(tenant, actor, request()));
  const view = render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check retained request' }));
  await screen.findByText(/No positive receipt was found/);
  fireEvent.change(screen.getByLabelText('Cancellation reason'), {
    target: { value: 'Stale predecessor, abandon exact intent' },
  });
  fireEvent.click(
    screen.getByLabelText(
      'I request recorded cancellation of this exact unresolved intent, with fresh MFA.',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Prepare recorded cancellation' }));
  await screen.findByRole('button', { name: 'Check retained cancellation' });
  expect(api.resolution).not.toHaveBeenCalled();
  expect(readCustodyIntents(localStorage, tenant, actor)).toHaveLength(1);
  view.unmount();
  render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check retained cancellation' }));
  await screen.findByText(/No positive receipt was found/);
  expect(readCustodyIntents(localStorage, tenant, actor)).toHaveLength(1);
  fireEvent.click(
    screen.getByLabelText(
      'I reviewed this exact retained request and authorize its retry with fresh MFA.',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Request authenticator challenge' }));
  await screen.findByLabelText('Authenticator code');
  fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify authenticator' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Record exact cancellation' })).not.toHaveProperty(
      'disabled',
      true,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Record exact cancellation' }));
  await screen.findByText(/Cancellation receipt confirmed/);
  expect(readCustodyIntents(localStorage, tenant, actor)).toHaveLength(0);
  expect(api.step.mock.calls.map((c) => c[1])).toEqual(['recover']);
  expect(api.resolution.mock.calls.map((c) => c[1])).toEqual([
    'recover',
    'challenge',
    'verify',
    'record',
  ]);
});

it('an in-flight old-scope prepare cannot strand or clear the new-scope busy owner', async () => {
  let resolveA: (v: unknown) => void = () => {};
  api.step.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveA = resolve;
      }),
  );
  const view = render(<LocalCustodyClient tenantId={tenant} actorId={actor} />);
  await screen.findByText('No unresolved request in this organisation and account.');
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Reviewed old scope' } });
  fireEvent.change(screen.getByLabelText('Operator-reviewed non-secret manifest JSON'), {
    target: { value: JSON.stringify(manifest()) },
  });
  fireEvent.click(
    screen.getByLabelText('I reviewed the exact non-secret policy, selected action and reason.'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Prepare owner request' }));
  await waitFor(() => expect(api.step).toHaveBeenCalledTimes(1));
  view.rerender(<LocalCustodyClient tenantId={other} actorId={actor} />);
  await waitFor(() =>
    expect(api.load).toHaveBeenCalledWith({ tenantId: other, actorId: actor }, {}),
  );
  expect(screen.getByRole('button', { name: 'Refresh current policies' })).not.toHaveProperty(
    'disabled',
    true,
  );
  const calls = api.load.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current policies' }));
  await waitFor(() => expect(api.load.mock.calls.length).toBe(calls + 1));
  resolveA({ state: 'not_found' });
  await waitFor(() => expect(readCustodyIntents(localStorage, tenant, actor)).toHaveLength(0));
  expect(readCustodyIntents(localStorage, other, actor)).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Refresh current policies' })).not.toHaveProperty(
    'disabled',
    true,
  );
});
