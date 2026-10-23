// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DelegationManager, OwnerRecoveryPanel } from './delegation-panels';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const delegation = {
  delegation_id: 'd1',
  owner_user_id: 'o1',
  owner_email: 'persona-owner@example.invalid',
  tenant_id: 't1',
  tenant_name: 'Kosha',
  target_roles: ['approver', 'viewer'],
  version: 1,
  reason: 'Owner covers weekend recoveries',
  expires_at: '2026-10-24T00:00:00Z',
  revoked_at: null,
  eligible: [{ user_id: 'm1', email: 'persona-approver@example.invalid', role: 'approver' }],
};

it('founder loads delegations with a visible button and issues one only when every field is valid', async () => {
  fetchMock
    .mockResolvedValueOnce(
      json({
        owners: [{ user_id: 'o1', email: 'persona-owner@example.invalid', tenant_id: 't1' }],
        delegations: [delegation],
        cases: [],
      }),
    )
    .mockResolvedValueOnce(json({ delegation_id: 'd2' }, 201))
    .mockResolvedValueOnce(json({ owners: [], delegations: [], cases: [] }));
  render(<DelegationManager tenantId="t1" tenantName="Kosha" />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage owner delegations' }));
  expect((await screen.findByTestId('mfa-recovery-delegation')).textContent).toContain(
    'persona-owner@example.invalid',
  );
  const delegate = screen.getByRole('button', { name: 'Delegate' }) as HTMLButtonElement;
  expect(document.getElementById('delegateMissing')?.textContent).toBe(
    'Still needed: an owner, a reason of at least 10 characters, your authenticator code.',
  );
  fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'o1' } });
  fireEvent.change(screen.getByLabelText('Why this owner'), {
    target: { value: 'Owner covers weekend recoveries' },
  });
  fireEvent.change(screen.getByLabelText('Your authenticator code'), {
    target: { value: '123456' },
  });
  expect(delegate.disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Days (1–30)'), { target: { value: '31' } });
  expect(delegate.disabled).toBe(true);
  expect(document.getElementById('delegateMissing')?.textContent).toBe(
    'Still needed: days between 1 and 30.',
  );
  fireEvent.change(screen.getByLabelText('Days (1–30)'), { target: { value: '7' } });
  fireEvent.click(delegate);
  expect((await screen.findByRole('status')).textContent).toBe('Delegation issued.');
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
    ownerUserId: 'o1',
    targetRoles: ['approver'],
    expiresInDays: 7,
    reason: 'Owner covers weekend recoveries',
    code: '123456',
  });
});

it('shows a refused load as an alert, not a silent failure', async () => {
  fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_founder' } }, 403));
  render(<DelegationManager tenantId="t1" tenantName="Kosha" />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage owner delegations' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Delegations unavailable (not_founder)',
  );
});

it('owner without a delegation is told so; with one, sees the scope and member list', async () => {
  fetchMock.mockResolvedValueOnce(json({ owners: [], delegations: [], cases: [] }));
  render(<OwnerRecoveryPanel tenantId="t1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Check my recovery delegation' }));
  await screen.findByText('No founder has delegated recovery to you for this organisation.');
  cleanup();
  fetchMock.mockResolvedValueOnce(json({ owners: [], delegations: [delegation], cases: [] }));
  render(<OwnerRecoveryPanel tenantId="t1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Check my recovery delegation' }));
  expect((await screen.findByText(/^Delegated for approver, viewer until/)).tagName).toBe('P');
  expect(
    screen.getByRole('option', { name: 'persona-approver@example.invalid (approver)' }),
  ).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Open recovery' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
