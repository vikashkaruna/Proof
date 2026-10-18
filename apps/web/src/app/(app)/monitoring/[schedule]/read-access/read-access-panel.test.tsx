// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ReadAccessPanel } from './read-access-panel';
import { saveReadJournal, loadReadJournal } from '../../read-journal';
const id = (n: number) => `11111111-1111-4111-8111-${n.toString().padStart(12, '0')}`;
const props = { tenantId: id(1), actorId: id(2), scheduleId: id(3) };
const context = {
  ...props,
  estateId: id(4),
  kind: 'rediscovery',
  cadence: '* * * * *',
  status: 'active',
  scopeId: null,
  scopes: [],
  fires: [],
  targets: [
    {
      connectorId: id(5),
      name: 'Synthetic PostgreSQL',
      configurationSha256: 'a'.repeat(64),
      grantId: id(6),
      maxExpiresAt: '2030-01-01T00:00:00Z',
    },
  ],
  engagements: [{ id: id(7), title: 'Synthetic review' }],
  preflights: [
    {
      requestId: id(8),
      connectorId: id(5),
      engagementId: id(7),
      configurationSha256: 'a'.repeat(64),
      grantId: id(6),
      completedAt: '2026-10-19T00:00:00Z',
    },
  ],
};
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: unknown, _opts: unknown, fn: (lock: object) => unknown) => fn({}),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const load = async () => {
  fireEvent.click(
    screen.getByRole('button', { name: 'Load current schedule and retained request' }),
  );
  await screen.findByText('No recorded binding');
};
it('never sends on mount and shows unavailable actual controller honestly', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ data: context, preflightAvailable: false }));
  vi.stubGlobal('fetch', fetcher);
  render(<ReadAccessPanel {...props} />);
  expect(fetcher).not.toHaveBeenCalled();
  await load();
  expect(screen.getByText(/Discovery controller is unavailable/)).toBeTruthy();
  expect(
    screen
      .getByRole('button', { name: 'Run supervised read-only preflight' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('retains approval before sending, validates actor headers and preserves lost challenge reply', async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async (url: string) =>
      url.endsWith('read-scope')
        ? Response.json({ data: context, preflightAvailable: true })
        : Promise.reject(Error('lost reply')),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<ReadAccessPanel {...props} />);
  await load();
  fireEvent.change(screen.getByLabelText('Enrolled connector'), { target: { value: id(5) } });
  fireEvent.change(screen.getByLabelText('Engagement'), { target: { value: id(7) } });
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Reviewed synthetic metadata read scope' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review 30-minute read scope' }));
  await screen.findByText('Retained original request');
  expect(fetcher.mock.calls.filter(([, o]) => o.method === 'POST')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare approval challenge' }));
  await screen.findByRole('alert');
  const retained = loadReadJournal(localStorage, id(1), id(2));
  expect(retained?.kind).toBe('scope');
  expect(JSON.stringify(retained)).not.toContain('code');
  expect(fetcher.mock.calls.at(-1)?.[1].headers).toMatchObject({
    'X-Expected-Actor-Id': id(2),
    'X-Tenant-Id': id(1),
  });
  expect(screen.queryByRole('button', { name: 'Review 30-minute read scope' })).toBeNull();
});
it('does not replace an unresolved request from another schedule', async () => {
  saveReadJournal(localStorage, {
    ...props,
    scheduleId: id(99),
    kind: 'preflight',
    operationKey: id(8),
    connectorId: id(5),
    engagementId: id(7),
  });
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ data: context, preflightAvailable: true }));
  vi.stubGlobal('fetch', fetcher);
  render(<ReadAccessPanel {...props} />);
  await load();
  expect(
    screen.getByRole('link', { name: 'its original schedule' }).getAttribute('href'),
  ).toContain(id(99));
  expect(screen.queryByRole('button', { name: 'Run supervised read-only preflight' })).toBeNull();
});
it('rejects malformed projected context without enabling actions', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: { ...context, targets: [{ ...context.targets[0], password: 'forbidden' }] },
        preflightAvailable: true,
      }),
    ),
  );
  render(<ReadAccessPanel {...props} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Load current schedule and retained request' }),
  );
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Run supervised read-only preflight' })).toBeNull();
});
