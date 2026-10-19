// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OnboardingForm } from './onboarding-form';
import { readOnboardingJournal } from './operation-journal';
const actor = '11111111-1111-4111-8111-111111111111',
  tenant = '22222222-2222-4222-8222-222222222222',
  engagement = '33333333-3333-4333-8333-333333333333';
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: unknown,
        work: (lock: unknown) => Promise<unknown>,
      ) => work({ name: 'synthetic-browser-lock' }),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const form = () =>
  render(
    <OnboardingForm
      userId={actor}
      userEmail="owner@example.invalid"
      userFullName="Synthetic reviewer"
    />,
  );
function submit() {
  fireEvent.change(screen.getByLabelText('Organization Legal Name *'), {
    target: { value: ' Synthetic company ' },
  });
  fireEvent.submit(
    screen.getByRole('button', { name: /Complete organization setup/ }).closest('form')!,
  );
}
function response(state = 'unconfirmed') {
  const j = readOnboardingJournal(localStorage, actor)!;
  return Response.json({
    data: {
      actorId: actor,
      operationKey: j.operationKey,
      requestSha256: j.requestSha256,
      state,
      ...(state === 'recorded'
        ? {
            tenantId: tenant,
            engagementId: engagement,
            intakeTenantId: tenant,
            libraryVersion: '0.1.1',
            ledgerId: '1',
            ledgerSha256: 'b'.repeat(64),
            createdAt: '2026-10-19T00:00:00Z',
          }
        : {}),
    },
  });
}
it('durably binds original intent before network and opens only exact recorded assessment', async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async (_url: string, init: RequestInit) =>
      response(init.method === 'GET' ? 'unconfirmed' : 'recorded'),
    );
  vi.stubGlobal('fetch', fetcher);
  form();
  submit();
  await waitFor(() =>
    expect(router.push).toHaveBeenCalledWith(`/assessment?engagement=${engagement}`),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  const body = JSON.parse(String(fetcher.mock.calls[1]?.[1].body)) as {
    request: { name: string; systems: unknown[] };
  };
  expect(body.request.name).toBe('Synthetic company');
  expect(body.request.systems).toEqual([]);
  expect(document.cookie).toContain(`axiom_active_tenant=${tenant}`);
  expect(localStorage.getItem(localStorage.key(0)!)).not.toContain('Synthetic company');
  expect(screen.queryByText('Initial Data Systems for Drishti Discovery Scan')).toBeNull();
});
it('lost creation reply survives reload and recovers without a duplicate create', async () => {
  const fetcher = vi
    .fn()
    .mockImplementationOnce(async () => response())
    .mockRejectedValueOnce(Error('lost reply'));
  vi.stubGlobal('fetch', fetcher);
  const view = form();
  submit();
  await waitFor(() => expect(screen.getByText('lost reply')).toBeTruthy());
  expect(readOnboardingJournal(localStorage, actor)).not.toBeNull();
  view.unmount();
  fetcher.mockImplementation(async () => response('recorded'));
  form();
  fireEvent.click(screen.getByRole('button', { name: 'Check saved outcome' }));
  await waitFor(() =>
    expect(router.push).toHaveBeenCalledWith(`/assessment?engagement=${engagement}`),
  );
  expect(fetcher.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'POST', 'GET']);
});
it('refuses blank organization without contacting the BFF', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  form();
  fireEvent.submit(
    screen.getByRole('button', { name: /Complete organization setup/ }).closest('form')!,
  );
  expect(screen.getByText('Organization name is required.')).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});
it('fails closed when safe browser coordination is unavailable', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  form();
  submit();
  await waitFor(() =>
    expect(screen.getByText(/Safe request coordination is unavailable/)).toBeTruthy(),
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
});

it('changed fields cannot silently replace a retained uncertain organization', async () => {
  const fetcher = vi
    .fn()
    .mockImplementationOnce(async () => response())
    .mockRejectedValueOnce(Error('lost create response'));
  vi.stubGlobal('fetch', fetcher);
  form();
  submit();
  await waitFor(() => expect(screen.getByText('lost create response')).toBeTruthy());
  const original = readOnboardingJournal(localStorage, actor);
  fireEvent.change(screen.getByLabelText('Organization Legal Name *'), {
    target: { value: 'Different organization' },
  });
  fireEvent.submit(
    screen.getByRole('button', { name: /Complete organization setup/ }).closest('form')!,
  );
  await waitFor(() =>
    expect(screen.getByText(/Re-enter the original fields, or check and close/)).toBeTruthy(),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(readOnboardingJournal(localStorage, actor)).toEqual(original);
});
it('storage failure prevents original creation network traffic', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  form();
  const store = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('storage denied');
  });
  submit();
  await waitFor(() => expect(screen.getByText('storage denied')).toBeTruthy());
  expect(fetcher).not.toHaveBeenCalled();
  store.mockRestore();
});
it('fences only with the exact original transient body and never persists personal fields', async () => {
  const fetcher = vi
    .fn()
    .mockImplementationOnce(async () => response())
    .mockRejectedValueOnce(Error('lost create reply'))
    .mockImplementationOnce(async () => response('fenced'));
  vi.stubGlobal('fetch', fetcher);
  form();
  submit();
  await waitFor(() => expect(screen.getByText('lost create reply')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Close original request safely' }));
  await waitFor(() =>
    expect(screen.getByText(/The original request is closed without creating/)).toBeTruthy(),
  );
  const create = String(fetcher.mock.calls[1]?.[1].body);
  const fence = JSON.parse(String(fetcher.mock.calls[2]?.[1].body)) as {
    originalCreateBody: string;
  };
  expect(fence.originalCreateBody).toBe(create);
  expect(localStorage.getItem(localStorage.key(0)!)).not.toContain('Synthetic company');
});
