// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MembersClient, type InvitationRow } from './members-client';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('../../estate/estate-client', () => ({ MutationForm: ({ label }: { label: string }) => <button>{label}</button> }));
const base = { tenantId: 'tenant-1', canInviteOwners: false, members: [{ userId: 'user-1', email: 'owner@example.invalid', role: 'owner', acceptedAt: '2026-09-30T00:00:00Z' }], invitations: [] as InvitationRow[] };

beforeEach(() => { refresh.mockReset(); vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('does not offer owner or admin roles to a persona without invite-owner authority', () => {
  render(<MembersClient {...base} />);
  const roles = screen.getByLabelText('Role') as HTMLSelectElement;
  expect([...roles.options].map((option) => option.value)).toEqual(['approver', 'reviewer', 'viewer']);
  expect(screen.getByTestId('member-list').textContent).toContain('owner@example.invalid');
});

it('sends scoped invitation fields with a stable idempotency key and shows its secret link once', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { delivery_status: 'not_configured' }, token: 'a'.repeat(43) }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  render(<MembersClient {...base} canInviteOwners />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'approver@example.invalid' } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'approver' } });
  fireEvent.change(screen.getByLabelText(/Approval scopes/), { target: { value: ' plan.approve, evidence.read, ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
  await waitFor(() => expect(screen.getByTestId('invite-link')).toBeTruthy());
  expect(screen.getByRole('status').textContent).toContain('Email not configured');
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('/api/bff/v1/tenant/invitations');
  expect(init.headers).toMatchObject({ 'X-Tenant-Id': 'tenant-1', 'Idempotency-Key': 'uuid-1' });
  expect(JSON.parse(init.body)).toEqual({ email: 'approver@example.invalid', role: 'approver', approvalScopes: ['plan.approve', 'evidence.read'] });
  expect((screen.getByTestId('invite-link') as HTMLInputElement).value).toContain('/invite#token=');
  expect(refresh).toHaveBeenCalledOnce();
});

it('reuses the same request key after an ambiguous outage instead of duplicating an invitation', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json({ data: { delivery_status: 'pending' } }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  render(<MembersClient {...base} />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'reader@example.invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('result is unknown'));
  fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Invitation created'));
  expect(fetcher.mock.calls[0]![1].headers['Idempotency-Key']).toBe(fetcher.mock.calls[1]![1].headers['Idempotency-Key']);
});

it('distinguishes accepted, revoked and expired invitations from open ones', () => {
  const row = (id: string, overrides: Partial<InvitationRow>): InvitationRow => ({ id, email: `${id}@example.invalid`, role: 'viewer', approval_scopes: [], created_at: '2026-09-30T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', accepted_at: null, revoked_at: null, delivery_status: 'sent', ...overrides });
  render(<MembersClient {...base} invitations={[
    row('accepted', { accepted_at: '2026-09-30T00:00:00Z' }),
    row('revoked', { revoked_at: '2026-09-30T00:00:00Z' }),
    row('expired', { expires_at: '2020-01-01T00:00:00Z' }),
    row('open', {}),
  ]} />);
  expect(screen.getByTestId('invitation-state-accepted@example.invalid').textContent).toBe('Accepted');
  expect(screen.getByTestId('invitation-state-revoked@example.invalid').textContent).toBe('Revoked');
  expect(screen.getByTestId('invitation-state-expired@example.invalid').textContent).toBe('Expired');
  expect(screen.getByTestId('invitation-state-open@example.invalid').textContent).toContain('Emailed');
  expect(screen.getAllByRole('button', { name: /Revoke/ })).toHaveLength(1);
});
