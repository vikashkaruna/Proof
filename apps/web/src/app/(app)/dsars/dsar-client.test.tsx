// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DsarClient } from './dsar-client';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const row = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'access' as const,
  status: 'received' as const,
  data_principal_name: 'Person A',
  data_principal_email: 'person@example.com',
  data_principal_phone: null,
  identity_verified: false,
  identity_verification_method: null,
  received_at: '2026-10-01T00:00:00Z',
  due_by: '2026-10-31T00:00:00Z',
  completed_at: null,
  rejection_reason: null,
  notes: null,
};
const props = {
  tenantId: 'tenant-1',
  rows: [row],
  loadError: null,
  hasMore: false,
  asOf: Date.parse('2026-10-02T00:00:00Z'),
};

beforeEach(() => {
  refresh.mockReset();
  vi.stubGlobal('crypto', { randomUUID: () => 'request-1' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps a reader in read-only mode and labels identity as unverified', () => {
  render(<DsarClient {...props} canManage={false} />);
  expect(screen.getByText(/Read-only access/)).toBeTruthy();
  expect(screen.getByText('Not verified')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Record request' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Record identity verification' })).toBeNull();
});

it('does not submit an intake without an email or phone', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<DsarClient {...props} canManage />);
  fireEvent.click(screen.getByRole('button', { name: 'Record request' }));
  fireEvent.submit(
    screen.getByRole('button', { name: 'Record and start deadline' }).closest('form')!,
  );
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('email or phone is required'),
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it('retries an ambiguous intake with the same payload and idempotency key', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(Response.json({ data: { dsarId: row.id } }));
  vi.stubGlobal('fetch', fetcher);
  render(<DsarClient {...props} canManage />);
  fireEvent.click(screen.getByRole('button', { name: 'Record request' }));
  fireEvent.change(screen.getByLabelText('Principal phone'), {
    target: { value: '+919900000001' },
  });
  const form = screen.getByRole('button', { name: 'Record and start deadline' }).closest('form')!;
  fireEvent.submit(form);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Connection lost'));
  fireEvent.submit(form);
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]![1].headers['Idempotency-Key']).toBe('request-1');
  expect(fetcher.mock.calls[1]![1].headers['Idempotency-Key']).toBe('request-1');
  expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toMatchObject({
    principalPhone: '+919900000001',
    dueDays: 30,
  });
});
