// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MfaEnrolment } from './mfa-enrolment';

const empty = { enrolled: false, recoveryCodesRemaining: 0, factors: [] };
const active = {
  enrolled: true,
  recoveryCodesRemaining: 3,
  factors: [
    {
      id: 'factor-1',
      factorType: 'totp',
      status: 'active',
      label: 'Authenticator',
      activatedAt: '2026-09-30T00:00:00Z',
      lastUsedAt: null,
    },
  ],
};
const base = { tenantId: 'tenant-1', accountEmail: 'owner@example.invalid' };

beforeEach(() => vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps the initial enrolment and replacement controls disabled until hydration', () => {
  const firstPaint = renderToStaticMarkup(<MfaEnrolment {...base} initialStatus={empty} />);
  expect(firstPaint).toMatch(/<button[^>]*disabled=""[^>]*>Enrol an authenticator<\/button>/);
  const replacementPaint = renderToStaticMarkup(<MfaEnrolment {...base} initialStatus={active} />);
  expect(replacementPaint).toMatch(/<button[^>]*disabled=""[^>]*>Replace authenticator<\/button>/);
  expect(replacementPaint).toMatch(/<button[^>]*disabled=""[^>]*>Revoke authenticator<\/button>/);

  render(<MfaEnrolment {...base} initialStatus={empty} />);
  expect(
    screen.getByRole('button', { name: 'Enrol an authenticator' }).hasAttribute('disabled'),
  ).toBe(false);
});

it('enrols a first authenticator, then shows recovery codes once after activation', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        factorId: 'factor-1',
        secret: 'SETUPKEY',
        provisioningUri: 'otpauth://totp/Axiom',
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ factorId: 'factor-1', recoveryCodes: ['recover-1', 'recover-2'] }),
    )
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
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/api/bff/v1/mfa/enrol',
    '/api/bff/v1/mfa/enrol/activate',
    '/api/bff/v1/mfa/status',
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'I have saved them' }));
  expect(screen.queryByTestId('recovery-codes')).toBeNull();
});

it('requires an existing factor challenge before replacement enrolment', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-1' }))
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-1', satisfied: true }))
    .mockResolvedValueOnce(
      Response.json({
        factorId: 'factor-2',
        secret: 'NEWKEY',
        provisioningUri: 'otpauth://totp/Axiom',
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={active} />);
  fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
  await waitFor(() => expect(screen.getByTestId('mfa-replace-step-up')).toBeTruthy());
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
    purpose: 'enrolment',
    factorId: 'factor-1',
  });
  expect(fetcher.mock.calls[0]![1].headers['Idempotency-Key']).toMatch(/^mfa-challenge-/);
  fireEvent.change(screen.getByLabelText('Current code or recovery code'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and replace' }));
  await waitFor(() => expect(screen.getByText('NEWKEY')).toBeTruthy());
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toMatchObject({
    mfaChallengeId: 'challenge-1',
  });
});

it('refuses an exhausted replacement challenge and never requests a new factor', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-1' }))
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 'attempts_exhausted', message: 'Challenge exhausted' } },
        { status: 403 },
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={active} />);
  fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
  await waitFor(() => expect(screen.getByTestId('mfa-replace-step-up')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Current code or recovery code'), {
    target: { value: '000000' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and replace' }));
  await waitFor(() => expect(screen.getByText('Challenge exhausted')).toBeTruthy());
  expect(screen.queryByTestId('mfa-replace-step-up')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('requires step-up before factor revocation and reports the session consequence', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-2' }))
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-2', satisfied: true }))
    .mockResolvedValueOnce(Response.json({ factorId: 'factor-1', status: 'revoked' }))
    .mockResolvedValueOnce(Response.json(empty));
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={active} />);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke authenticator' }));
  await waitFor(() => expect(screen.getByTestId('mfa-revoke-step-up')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Current code or recovery code'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('MFA-verified sessions have ended'),
  );
  expect(fetcher.mock.calls[2]![0]).toBe('/api/bff/v1/mfa/factors/factor-1/revoke');
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({ mfaChallengeId: 'challenge-2' });
});

it('refuses an enrolment body with no verified setup key or safe authenticator URI', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      factorId: 'factor-1',
      secret: 'SETUPKEY',
      provisioningUri: 'javascript:alert(1)',
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={empty} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enrol an authenticator' }));
  await waitFor(() => expect(screen.getByText(/Enrolment response is unverified/)).toBeTruthy());
  expect(screen.queryByText('SETUPKEY')).toBeNull();
  expect(screen.queryByRole('link', { name: /open this link/i })).toBeNull();
});

it('does not spend a challenge after an unconfirmed verification response', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-1' }))
    .mockResolvedValueOnce(Response.json({ satisfied: false, challengeId: 'challenge-1' }));
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={active} />);
  fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
  await waitFor(() => expect(screen.getByTestId('mfa-replace-step-up')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Current code or recovery code'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and replace' }));
  await waitFor(() => expect(screen.getByText(/Verification result is unconfirmed/)).toBeTruthy());
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByTestId('mfa-replace-step-up')).toBeNull();
});

it('does not claim factor revocation from a wrong-factor HTTP success', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-2' }))
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-2', satisfied: true }))
    .mockResolvedValueOnce(Response.json({ factorId: 'other-factor', status: 'revoked' }));
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={active} />);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke authenticator' }));
  await waitFor(() => expect(screen.getByTestId('mfa-revoke-step-up')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Current code or recovery code'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));
  await waitFor(() => expect(screen.getByText(/Revocation result is unconfirmed/)).toBeTruthy());
  expect(screen.queryByRole('status')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('does not display recovery codes from an unrelated activation response', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        factorId: 'factor-1',
        secret: 'SETUPKEY',
        provisioningUri: 'otpauth://totp/Axiom',
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ factorId: 'other-factor', recoveryCodes: ['unsafe-code'] }),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={empty} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enrol an authenticator' }));
  await waitFor(() => expect(screen.getByText('SETUPKEY')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
  await waitFor(() => expect(screen.getByText(/Activation result is unconfirmed/)).toBeTruthy());
  expect(screen.queryByTestId('recovery-codes')).toBeNull();
});

it('disables further factor changes when activation succeeds but the live status re-read is malformed', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        factorId: 'factor-1',
        secret: 'SETUPKEY',
        provisioningUri: 'otpauth://totp/Axiom',
      }),
    )
    .mockResolvedValueOnce(Response.json({ factorId: 'factor-1', recoveryCodes: ['recover-1'] }))
    .mockResolvedValueOnce(Response.json({ enrolled: true, factors: null }));
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={empty} enrolmentRequired />);
  fireEvent.click(screen.getByRole('button', { name: 'Enrol an authenticator' }));
  await screen.findByText('SETUPKEY');
  fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
  await screen.findByText(/Factor status is unavailable/);
  expect(
    screen.getByRole('button', { name: 'Enrol an authenticator' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getByText('Status unavailable')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Continue to sign-in verification' })).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('does not offer another revocation after a confirmed revoke with an unreadable status', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-2' }))
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-2', satisfied: true }))
    .mockResolvedValueOnce(Response.json({ factorId: 'factor-1', status: 'revoked' }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  render(<MfaEnrolment {...base} initialStatus={active} enrolmentRequired />);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke authenticator' }));
  await screen.findByTestId('mfa-revoke-step-up');
  fireEvent.change(screen.getByLabelText('Current code or recovery code'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));
  await screen.findByText(/Factor status is unavailable/);
  expect(
    screen.getByRole('button', { name: 'Revoke authenticator' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    screen.getByRole('button', { name: 'Replace authenticator' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.queryByRole('link', { name: 'Continue to sign-in verification' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke authenticator' }));
  expect(fetcher).toHaveBeenCalledTimes(4);
});
