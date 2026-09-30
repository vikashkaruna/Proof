// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MfaEnrolment } from './mfa-enrolment';

const empty = { enrolled: false, recoveryCodesRemaining: 0, factors: [] };
const active = { enrolled: true, recoveryCodesRemaining: 3, factors: [{ id: 'factor-1', factorType: 'totp', status: 'active', label: 'Authenticator', activatedAt: '2026-09-30T00:00:00Z', lastUsedAt: null }] };
const base = { tenantId: 'tenant-1', accountEmail: 'owner@example.invalid' };

beforeEach(() => vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('enrols a first authenticator, then shows recovery codes once after activation', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ factorId: 'factor-1', secret: 'SETUPKEY', provisioningUri: 'otpauth://totp/Axiom' }))
    .mockResolvedValueOnce(Response.json({ recoveryCodes: ['recover-1', 'recover-2'] }))
    .mockResolvedValueOnce(Response.json(active));
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={empty} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enrol an authenticator' }));
  await waitFor(() => expect(screen.getByText('SETUPKEY')).toBeTruthy());
  expect(fetcher.mock.calls[0]![0]).toBe('/api/bff/v1/mfa/enrol');
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).not.toHaveProperty('mfaChallengeId');
  fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
  await waitFor(() => expect(screen.getAllByTestId('recovery-code')).toHaveLength(2));
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/bff/v1/mfa/enrol', '/api/bff/v1/mfa/enrol/activate', '/api/bff/v1/mfa/status']);
  fireEvent.click(screen.getByRole('button', { name: 'I have saved them' }));
  expect(screen.queryByTestId('recovery-codes')).toBeNull();
});

it('requires an existing factor challenge before replacement enrolment', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-1' }))
    .mockResolvedValueOnce(Response.json({ verified: true }))
    .mockResolvedValueOnce(Response.json({ factorId: 'factor-2', secret: 'NEWKEY', provisioningUri: 'otpauth://totp/Axiom' }));
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={active} />);
  fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
  await waitFor(() => expect(screen.getByTestId('mfa-replace-step-up')).toBeTruthy());
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ purpose: 'enrolment', factorId: 'factor-1' });
  expect(fetcher.mock.calls[0]![1].headers['Idempotency-Key']).toMatch(/^mfa-challenge-/);
  fireEvent.change(screen.getByLabelText('Current code or recovery code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and replace' }));
  await waitFor(() => expect(screen.getByText('NEWKEY')).toBeTruthy());
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toMatchObject({ mfaChallengeId: 'challenge-1' });
});

it('refuses an exhausted replacement challenge and never requests a new factor', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-1' }))
    .mockResolvedValueOnce(Response.json({ error: { code: 'attempts_exhausted', message: 'Challenge exhausted' } }, { status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={active} />);
  fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
  await waitFor(() => expect(screen.getByTestId('mfa-replace-step-up')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Current code or recovery code'), { target: { value: '000000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and replace' }));
  await waitFor(() => expect(screen.getByText('Challenge exhausted')).toBeTruthy());
  expect(screen.queryByTestId('mfa-replace-step-up')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('requires step-up before factor revocation and reports the session consequence', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-2' }))
    .mockResolvedValueOnce(Response.json({ verified: true }))
    .mockResolvedValueOnce(Response.json({ revoked: true }))
    .mockResolvedValueOnce(Response.json(empty));
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={active} />);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke authenticator' }));
  await waitFor(() => expect(screen.getByTestId('mfa-revoke-step-up')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Current code or recovery code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('MFA-verified sessions have ended'));
  expect(fetcher.mock.calls[2]![0]).toBe('/api/bff/v1/mfa/factors/factor-1/revoke');
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({ mfaChallengeId: 'challenge-2' });
});
