// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InviteAccept } from './invite-accept';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  push.mockReset();
});

it('hides a fragment token, redirects a signed-out caller, and accepts only a recorded membership', async () => {
  const token = 'a'.repeat(43);
  window.history.replaceState(null, '', `/invite#token=${token}`);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ data: { tenantId: 'tenant-1' } }));
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' });
  const fallbackTimer = vi.spyOn(window, 'setTimeout');
  const view = render(<InviteAccept />);
  const button = await screen.findByRole('button', { name: 'Accept invitation' });
  expect(window.location.hash).toBe('');
  expect(sessionStorage.getItem('axiom_invitation_token')).toBe(token);
  fireEvent.click(button);
  await waitFor(() => expect(push).toHaveBeenCalledWith('/login?redirect=/invite'));
  expect(document.cookie).not.toContain('axiom_active_tenant');
  fireEvent.click(button);
  await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
  expect(screen.getByRole('link', { name: 'Open dashboard' }).getAttribute('href')).toBe(
    '/dashboard',
  );
  expect(screen.queryByText(/no invitation token/i)).toBeNull();
  await waitFor(() => expect(fallbackTimer).toHaveBeenCalledWith(expect.any(Function), 1_500));
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ token });
  expect(document.cookie).toContain('axiom_active_tenant=tenant-1');
  expect(sessionStorage.getItem('axiom_invitation_token')).toBeNull();
  view.unmount();
  render(<InviteAccept />);
  expect(screen.getByRole('link', { name: 'Open dashboard' })).toBeTruthy();
  expect(screen.queryByText(/no invitation token/i)).toBeNull();

  cleanup();
  window.history.replaceState(null, '', `/invite#token=${'b'.repeat(43)}`);
  render(<InviteAccept />);
  expect(await screen.findByRole('button', { name: 'Accept invitation' })).toBeTruthy();
  expect(sessionStorage.getItem('axiom_invitation_accepted_at')).toBeNull();
});
