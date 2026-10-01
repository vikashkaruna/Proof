// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConsentClient } from './consent-client';

const purpose = {
  id: '11111111-1111-4111-8111-111111111111',
  purpose_key: 'marketing',
  name_en: 'Marketing',
  name_hi: 'विपणन',
  lawful_basis: 'consent',
  notice_version: 2,
  notice_en: 'English notice',
  notice_hi: 'Hindi notice',
  is_active: true,
};
const record = {
  id: '22222222-2222-4222-8222-222222222222',
  purpose_id: purpose.id,
  principal_type: 'email',
  principal_ref: 'person@example.com',
  notice_version: 2,
  notice_snapshot_sha256: null,
  language: 'en',
  channel: 'form',
  status: 'granted',
  granted_at: '2026-10-01T00:00:00Z',
  granted_by: '33333333-3333-4333-8333-333333333333',
  expires_at: null,
  legal_hold: false,
};
const withdrawal = {
  id: '44444444-4444-4444-8444-444444444444',
  consent_record_id: record.id,
  purpose_id: purpose.id,
  principal_ref: record.principal_ref,
  downstream_completed_at: null,
  created_at: '2026-10-01T00:00:00Z',
};
const list = (data: unknown[], hasMore = false) => Response.json({ data, meta: { hasMore } });

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => 'request-1' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function reads(path: string) {
  return path.endsWith('/purposes') ? list([purpose]) : list([]);
}

it('distinguishes a recorded grant from current validity or a retained notice snapshot', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(async (url: string) =>
        url.endsWith('/purposes')
          ? list([purpose])
          : url.endsWith('/records')
            ? list([record])
            : list([]),
      ),
  );
  render(<ConsentClient tenantId="tenant-1" canManage={false} />);
  await waitFor(() => expect(screen.getByText('person@example.com')).toBeTruthy());
  expect(document.body.textContent).toContain(
    'Legacy record: exact notice snapshot at capture is unproven.',
  );
  expect(document.body.textContent).toContain(
    'A recorded grant alone does not establish current consent validity.',
  );
  expect(screen.queryByRole('button', { name: 'Withdraw consent' })).toBeNull();
});

it('requires a human downstream confirmation without claiming connector deletion', async () => {
  const fetcher = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    if (init.method === 'POST')
      return Response.json({
        data: { withdrawal_id: withdrawal.id, completed_at: '2026-10-01T01:00:00Z' },
      });
    return url.endsWith('/purposes')
      ? list([purpose])
      : url.endsWith('/withdrawals')
        ? list([withdrawal])
        : list([]);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<ConsentClient tenantId="tenant-1" canManage />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm downstream completion' })).toBeTruthy(),
  );
  expect(document.body.textContent).toContain('does not run a connector or prove deletion');
  const checkbox = screen.getByLabelText(/I have checked downstream processing has stopped/);
  expect((checkbox as HTMLInputElement).required).toBe(true);
  fireEvent.click(checkbox);
  fireEvent.submit(
    screen.getByRole('button', { name: 'Confirm downstream completion' }).closest('form')!,
  );
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Action recorded'));
  const mutation = fetcher.mock.calls.find(([, init]) => init.method === 'POST');
  expect(mutation?.[0]).toBe(`/api/bff/v1/consent/withdrawals/${withdrawal.id}/complete`);
  expect(mutation?.[1].headers['x-tenant-id']).toBe('tenant-1');
});

it('labels a legacy current notice as unproven rather than a reviewed publication', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) =>
      url.endsWith('/versions')
        ? list([
            {
              purpose_id: purpose.id,
              notice_version: 2,
              notice_en: 'English notice',
              notice_hi: null,
              snapshot_sha256: 'a'.repeat(64),
              provenance: 'legacy_current',
              created_at: '2026-10-01T00:00:00Z',
            },
          ])
        : reads(url),
    ),
  );
  render(<ConsentClient tenantId="tenant-1" canManage={false} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'View notice history' })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'View notice history' }));
  await waitFor(() =>
    expect(document.body.textContent).toContain('original capture text unproven'),
  );
  expect(document.body.textContent).not.toContain('Published reviewed snapshot');
});

it('shows recorded consent as read-only without exposing mutation controls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => reads(url)),
  );
  render(<ConsentClient tenantId="tenant-1" canManage={false} />);
  await waitFor(() =>
    expect(
      screen.getByText('Read-only access. A tenant administrator manages consent records.'),
    ).toBeTruthy(),
  );
  expect(screen.getByText('Marketing')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Record consent' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Publish notice' })).toBeNull();
});

it('fails closed when a BFF list is malformed', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(Response.json({ data: [{ id: 'fictional' }], meta: { hasMore: false } })),
  );
  render(<ConsentClient tenantId="tenant-1" canManage />);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Consent records could not be loaded'),
  );
  expect(screen.queryByText('fictional')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Record consent' })).toBeNull();
});

it('retries an ambiguous grant with the same idempotency key and recorded notice version', async () => {
  let mutationCount = 0;
  const fetcher = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    if (init.method === 'GET') return reads(url);
    mutationCount++;
    if (mutationCount === 1) throw new Error('offline');
    return Response.json({
      data: {
        consent_id: '22222222-2222-4222-8222-222222222222',
        status: 'granted',
        notice_version: 2,
        notice_snapshot_sha256: 'a'.repeat(64),
      },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<ConsentClient tenantId="tenant-1" canManage />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Record consent' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Record consent' }));
  fireEvent.change(screen.getByLabelText('Consent purpose'), { target: { value: purpose.id } });
  fireEvent.change(screen.getByLabelText('Principal identifier'), {
    target: { value: 'person@example.com' },
  });
  fireEvent.click(screen.getByLabelText(/I confirm the principal received this notice/));
  const form = screen.getByRole('button', { name: 'Save consent record' }).closest('form');
  expect(form).not.toBeNull();
  fireEvent.submit(form!);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Connection lost'));
  fireEvent.submit(form!);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Action recorded'));
  const mutations = fetcher.mock.calls.filter(([, init]) => init.method === 'POST');
  expect(mutations).toHaveLength(2);
  expect(mutations[0]![1].headers['Idempotency-Key']).toBe('request-1');
  expect(mutations[1]![1].headers['Idempotency-Key']).toBe('request-1');
  expect(mutations[1]![1].headers['x-tenant-id']).toBe('tenant-1');
  expect(mutations[0]![1].body).toBe(mutations[1]![1].body);
  expect(JSON.parse(mutations[1]![1].body)).toMatchObject({
    purposeId: purpose.id,
    expectedNoticeVersion: 2,
    principalRef: 'person@example.com',
  });
});

it('publishes a reviewed notice version against the observed version and reloads the source', async () => {
  const fetcher = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    if (init.method === 'POST')
      return Response.json({ data: { purpose_id: purpose.id, notice_version: 3 } });
    return reads(url);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<ConsentClient tenantId="tenant-1" canManage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Publish notice' }));
  fireEvent.change(screen.getByLabelText('English notice'), {
    target: { value: 'Reviewed English text' },
  });
  fireEvent.change(screen.getByLabelText('Hindi notice'), {
    target: { value: 'Reviewed Hindi text' },
  });
  fireEvent.click(screen.getByLabelText(/I reviewed and approve both notice texts/));
  fireEvent.submit(
    screen.getByRole('button', { name: 'Publish reviewed version' }).closest('form')!,
  );
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Action recorded'));
  const mutation = fetcher.mock.calls.find(([, init]) => init.method === 'POST');
  expect(mutation?.[0]).toBe(`/api/bff/v1/consent/purposes/${purpose.id}/versions`);
  expect(JSON.parse(mutation![1].body)).toEqual({
    expectedNoticeVersion: 2,
    noticeEn: 'Reviewed English text',
    noticeHi: 'Reviewed Hindi text',
    reviewed: true,
  });
});

it('requires a recorded withdrawal response before claiming completion and preserves the original record', async () => {
  const fetcher = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    if (init.method === 'POST')
      return Response.json({
        data: {
          consent_id: record.id,
          withdrawal_id: withdrawal.id,
          withdrawn_at: '2026-10-01T01:00:00Z',
        },
      });
    return url.endsWith('/purposes')
      ? list([purpose])
      : url.endsWith('/records')
        ? list([record])
        : list([]);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<ConsentClient tenantId="tenant-1" canManage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Withdraw consent' }));
  fireEvent.change(screen.getByLabelText('Withdrawal reason (optional)'), {
    target: { value: 'Principal request' },
  });
  fireEvent.click(screen.getByLabelText(/I confirm the principal requested this withdrawal/));
  fireEvent.submit(screen.getByRole('button', { name: 'Confirm withdrawal' }).closest('form')!);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Action recorded'));
  const mutation = fetcher.mock.calls.find(([, init]) => init.method === 'POST');
  expect(mutation?.[0]).toBe(`/api/bff/v1/consent/records/${record.id}/withdraw`);
  expect(JSON.parse(mutation![1].body)).toEqual({ language: 'en', reason: 'Principal request' });
  expect(screen.getByText('person@example.com')).toBeTruthy();
});

it('refuses an unconfirmed legal-hold response without claiming a recorded action', async () => {
  const fetcher = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') return Response.json({ data: null });
    return url.endsWith('/purposes')
      ? list([purpose])
      : url.endsWith('/records')
        ? list([record])
        : list([]);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<ConsentClient tenantId="tenant-1" canManage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Place legal hold' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Response could not be confirmed'),
  );
  expect(
    screen.queryByText('Action recorded. Saved records have been requested again.'),
  ).toBeNull();
  expect(document.body.textContent).toContain('No legal hold');
});
