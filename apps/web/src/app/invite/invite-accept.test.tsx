// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InviteAccept } from './invite-accept';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockReset(); });

it('hides a fragment token, redirects a signed-out caller, and accepts only a recorded membership', async () => {
  const token = 'a'.repeat(43);
  window.history.replaceState(null, '', `/invite#token=${token}`);
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ data: { tenantId: 'tenant-1' } }));
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' });
  render(<InviteAccept />);
  const button = await screen.findByRole('button', { name: 'Accept invitation' });
  expect(window.location.hash).toBe('');
  expect(sessionStorage.getItem('axiom_invitation_token')).toBe(token);
  fireEvent.click(button);
  await waitFor(() => expect(push).toHaveBeenCalledWith('/login?redirect=/invite'));
  expect(document.cookie).not.toContain('axiom_active_tenant');
  fireEvent.click(button);
  await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ token });
  expect(document.cookie).toContain('axiom_active_tenant=tenant-1');
  expect(sessionStorage.getItem('axiom_invitation_token')).toBeNull();
});
