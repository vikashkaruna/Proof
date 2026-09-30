// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApprovalActions } from './approval-actions';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const eligible = [{ id: 'action-1', action_type: 'connector.patch', description: 'Patch', risk_class: 'low' as const, approval_status: 'pending', dry_run_status: 'completed', rollback_validated: true }];
const blocked = [{ ...eligible[0]!, id: 'action-2', dry_run_status: 'pending', rollback_validated: false }];
const props = { planId: 'plan-1', tenantId: 'tenant-1', actions: [...eligible, ...blocked], eligible, blocked };

beforeEach(() => {
  refresh.mockReset();
  vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('exposes read-only status while clearly refusing blocked actions for approval', () => {
  render(<ApprovalActions {...props} />);
  expect(screen.getByText(/1 action\(s\) blocked/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  expect(screen.getByText(/read access to this plan/)).toBeTruthy();
});

it('binds the step-up challenge to only the eligible selected action and refuses enrolment failure', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: 'mfa_enrolment_required', message: 'Enrol a factor' } }, { status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  render(<ApprovalActions {...props} canApprove />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve 1 action' }));
  await waitFor(() => expect(screen.getByText('Enrol a factor')).toBeTruthy());
  expect(screen.getByText(/You have no second factor enrolled/)).toBeTruthy();
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('/api/bff/v1/mfa/challenge');
  expect(JSON.parse(init.body)).toEqual({ purpose: 'approval_issuance', planId: 'plan-1', actionIds: ['action-1'], mode: 'batch' });
  expect(init.headers['X-Tenant-Id']).toBe('tenant-1');
  expect(init.headers['Idempotency-Key']).toMatch(/^mfa-challenge-/);
});

it('never issues an approval token before successful step-up verification', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-1', expiresAt: '2026-10-01T00:00:00Z' }))
    .mockResolvedValueOnce(Response.json({ error: { code: 'attempts_exhausted', message: 'Invalid code' } }, { status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  render(<ApprovalActions {...props} canApprove />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve 1 action' }));
  await waitFor(() => expect(screen.getByLabelText(/6-digit code/)).toBeTruthy());
  fireEvent.change(screen.getByLabelText(/6-digit code/), { target: { value: '000000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify and approve' }));
  await waitFor(() => expect(screen.getByText('Invalid code')).toBeTruthy());
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByLabelText(/6-digit code/)).toBeNull();
});

it('invalidates an open MFA challenge when the action selection changes', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ challengeId: 'challenge-1', expiresAt: '2026-10-01T00:00:00Z' }));
  vi.stubGlobal('fetch', fetcher);
  render(<ApprovalActions {...props} canApprove />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve 1 action' }));
  await waitFor(() => expect(screen.getByLabelText(/6-digit code/)).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(screen.queryByLabelText(/6-digit code/)).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('lets an approver select an exact eligible subset but never a blocked action', async () => {
  const another = { ...eligible[0]!, id: 'action-3', description: 'Patch second' };
  const fetcher = vi.fn().mockResolvedValue(Response.json({ challengeId: 'challenge-2', expiresAt: '2026-10-01T00:00:00Z' }));
  vi.stubGlobal('fetch', fetcher);
  render(<ApprovalActions {...props} actions={[...props.actions, another]} eligible={[...eligible, another]} canApprove />);
  expect((screen.getByLabelText(/Requires a completed dry-run/) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/Patch second/));
  expect(screen.getByText('1 of 2 eligible selected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve 1 action' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).actionIds).toEqual(['action-1']);
});

it('spends a verified challenge on the exact selected scope, then exposes the separate execution step', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-1', expiresAt: '2026-10-01T00:00:00Z' }))
    .mockResolvedValueOnce(Response.json({ verified: true }))
    .mockResolvedValueOnce(Response.json({ token: { id: 'signed-token' } }));
  vi.stubGlobal('fetch', fetcher);
  render(<ApprovalActions {...props} canApprove canExecute />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve 1 action' }));
  await waitFor(() => expect(screen.getByLabelText(/6-digit code/)).toBeTruthy());
  fireEvent.change(screen.getByLabelText(/6-digit code/), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify and approve' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Execute approved actions' })).toBeTruthy());
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/api/bff/v1/mfa/challenge', '/api/bff/v1/mfa/challenge/challenge-1/verify', '/api/bff/v1/plans/approve',
  ]);
  const approval = JSON.parse(fetcher.mock.calls[2]![1].body);
  expect(approval).toMatchObject({ planId: 'plan-1', actionIds: ['action-1'], mfaChallengeId: 'challenge-1' });
  expect(refresh).toHaveBeenCalled();
});

it('reports an ambiguous execution outcome without claiming acceptance', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ status: 'dispatch_unknown', acceptedActionIds: [], rejectedActionIds: [] }, { status: 202 }));
  vi.stubGlobal('fetch', fetcher);
  render(<ApprovalActions {...props} canExecute initialApprovalToken="signed-token" initialApprovedActionIds={['action-1']} />);
  fireEvent.click(screen.getByRole('button', { name: 'Execute approved actions' }));
  await waitFor(() => expect(screen.getByText(/Dispatch outcome unknown/)).toBeTruthy());
  expect(screen.queryByText('Execution accepted.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Execute approved actions' })).toBeNull();
});
