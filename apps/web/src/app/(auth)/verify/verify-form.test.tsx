// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VerifyForm } from './verify-form';

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('./verified-navigation', () => ({ navigateAfterVerifiedMfa: navigation.replace }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
beforeEach(() => {
  navigation.replace.mockReset();
  let next = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++next}` });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const renderForm = () =>
  render(
    <VerifyForm
      redirectTo="/dashboard"
      tenantId="tenant-1"
      accountEmail="reader@example.invalid"
    />,
  );

it('opens a fresh single-use challenge and verifies code before redirecting', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-1' }))
    .mockResolvedValueOnce(Response.json({ verified: true }));
  vi.stubGlobal('fetch', fetcher);
  renderForm();
  expect(screen.getByRole('link', { name: 'Manage your authenticator' }).getAttribute('href')).toBe(
    '/settings/security',
  );
  expect(screen.getByRole('button', { name: 'Verify' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: ' 123456 ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/dashboard'));
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/api/bff/v1/mfa/challenge',
    '/api/bff/v1/mfa/challenge/challenge-1/verify',
  ]);
  expect(fetcher.mock.calls[0]![1].headers).toMatchObject({
    'X-Tenant-Id': 'tenant-1',
    'Idempotency-Key': 'mfa-challenge-uuid-1',
  });
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ code: '123456' });
});

it('refuses a failed challenge without sending a verification code or redirecting', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ error: { message: 'Factor unavailable' } }, { status: 503 }),
    );
  vi.stubGlobal('fetch', fetcher);
  renderForm();
  fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await waitFor(() => expect(screen.getByText('Factor unavailable')).toBeTruthy());
  expect(fetcher).toHaveBeenCalledOnce();
  expect(navigation.replace).not.toHaveBeenCalled();
});

it('does not treat a bad code as successful login', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ challengeId: 'challenge-1' }))
    .mockResolvedValueOnce(Response.json({ error: { message: 'Invalid code' } }, { status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  renderForm();
  fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '000000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await waitFor(() => expect(screen.getByText('Invalid code')).toBeTruthy());
  expect(navigation.replace).not.toHaveBeenCalled();
});
