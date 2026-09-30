// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EstateClient, MutationForm } from './estate-client';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const onSuccess = vi.fn();
const show = () => render(<MutationForm tenantId="tenant-1" path="/estates" method="POST" label="Save estate" body={(form) => ({ name: String(form.get('name')) })} onSuccess={onSuccess}>
  <label>Estate name<input name="name" defaultValue="Alpha" /></label>
</MutationForm>);

beforeEach(() => { refresh.mockReset(); onSuccess.mockReset(); vi.stubGlobal('crypto', { randomUUID: () => 'request-1' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps an ambiguous mutation frozen and retries with the exact same body and key', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json({ data: { id: 'estate-1' } }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
  await waitFor(() => expect(screen.getByText(/result is unknown/)).toBeTruthy());
  expect(screen.getByLabelText('Estate name').closest('fieldset')?.hasAttribute('disabled')).toBe(true);
  expect(onSuccess).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
  await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
  expect(fetcher.mock.calls[0]![1].headers['Idempotency-Key']).toBe(fetcher.mock.calls[1]![1].headers['Idempotency-Key']);
  expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
  expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST', headers: { 'X-Tenant-Id': 'tenant-1' } });
  expect(onSuccess).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
});

it('clears a rejected client request so a corrected submission can get a new key', async () => {
  let key = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `request-${++key}` });
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: { message: 'Invalid estate' } }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ data: { id: 'estate-1' } }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
  await waitFor(() => expect(screen.getByText('Invalid estate')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Estate name'), { target: { value: 'Corrected' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
  await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
  expect(fetcher.mock.calls[0]![1].headers['Idempotency-Key']).toBe('request-1');
  expect(fetcher.mock.calls[1]![1].headers['Idempotency-Key']).toBe('request-2');
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ name: 'Corrected' });
});

it('treats an idempotency conflict as uncertain rather than issuing a new mutation', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: 'idempotency_conflict', message: 'Conflict' } }, { status: 409 }));
  vi.stubGlobal('fetch', fetcher);
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Save estate' }));
  await waitFor(() => expect(screen.getByText('Keep this form open until the outcome is resolved.')).toBeTruthy());
  expect(onSuccess).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it('shows a viewer only recorded estate systems and distinguishes declared from observed categories', () => {
  render(<EstateClient tenantId="tenant-1" canManage={false} intakes={[]} estates={[{ id: 'estate-1', name: 'Production estate', slug: 'production', description: 'Verified client boundary', status: 'active', version: 1 }]} systems={[{ id: 'system-1', estate_id: 'estate-1', name: 'Payroll', system_kind: 'postgres', description: 'Client declared database', external_ref: null, status: 'active', version: 1, system_data_categories: [{ category_key: 'identity', source: 'declared' }, { category_key: 'financial', source: 'observed' }] }]} />);
  expect(document.body.textContent).toContain('Production estate');
  expect(document.body.textContent).toContain('Payroll');
  expect(document.body.textContent).toContain('Declared: identity');
  expect(document.body.textContent).toContain('Observed: financial');
  expect(screen.queryByText('Create estate')).toBeNull();
  expect(screen.queryByText('Edit system')).toBeNull();
});

it('shows an empty estate without inventing systems or assessments', () => {
  render(<EstateClient tenantId="tenant-1" canManage estates={[]} systems={[]} intakes={[]} />);
  expect(screen.getByText('No estates declared yet. A tenant owner or admin can create one.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Create estate' })).toBeTruthy();
  expect(document.body.textContent).not.toContain('production-core-postgres');
});
