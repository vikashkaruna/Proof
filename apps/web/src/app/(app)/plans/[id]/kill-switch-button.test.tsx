// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KillSwitchButton } from './kill-switch-button';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

beforeEach(() => {
  refresh.mockReset();
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('refuses mutation while selected-tenant status is unreadable', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  render(<KillSwitchButton tenantId="tenant-a" />);
  const control = screen.getByRole('button', { name: /Kill switch status unavailable/i });
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith('/api/bff/v1/kill-switch/status', {
      headers: { 'X-Tenant-Id': 'tenant-a' },
    }),
  );
  expect(control.hasAttribute('disabled')).toBe(true);
  fireEvent.click(control);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rereads the tenant instead of trusting an unscoped browser event', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ engaged: false }));
  vi.stubGlobal('fetch', fetcher);
  render(<KillSwitchButton tenantId="tenant-a" />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Engage kill switch/i })).toBeTruthy(),
  );
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('axiom:kill-switch-changed', { detail: { engaged: true } }),
    );
  });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('button', { name: /Disengage/i })).toBeNull();
});

it('reports engagement only when the BFF confirms the exact transition', async () => {
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      Response.json(url.endsWith('/engage') ? { engaged: true } : { engaged: false }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<KillSwitchButton tenantId="tenant-a" />);
  fireEvent.click(await screen.findByRole('button', { name: /Engage kill switch/i }));
  await waitFor(() => expect(screen.getByText(/Kill switch ENGAGED/)).toBeTruthy());
  expect(fetcher).toHaveBeenCalledWith(
    '/api/bff/v1/kill-switch/engage',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-Tenant-Id': 'tenant-a' }),
    }),
  );
  expect(refresh).toHaveBeenCalledOnce();
});

it('treats a successful HTTP response without a confirmed state as uncertain', async () => {
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      Response.json(url.endsWith('/engage') ? { accepted: true } : { engaged: false }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<KillSwitchButton tenantId="tenant-a" />);
  fireEvent.click(await screen.findByRole('button', { name: /Engage kill switch/i }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /status unavailable/i })).toBeTruthy(),
  );
  expect(screen.getByText(/status is unconfirmed/i)).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
});

it('keeps an engaged state when release is explicitly refused', async () => {
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      url.endsWith('/release')
        ? Response.json({ error: { message: 'Founder approval required' } }, { status: 403 })
        : Response.json({ engaged: true }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<KillSwitchButton tenantId="tenant-a" />);
  fireEvent.click(await screen.findByRole('button', { name: /Disengage/i }));
  await waitFor(() => expect(screen.getByText('Founder approval required')).toBeTruthy());
  expect(screen.getByRole('button', { name: /Disengage/i })).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
});

it('does not claim a release from an ambiguous success', async () => {
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      Response.json(url.endsWith('/release') ? { accepted: true } : { engaged: true }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<KillSwitchButton tenantId="tenant-a" />);
  fireEvent.click(await screen.findByRole('button', { name: /Disengage/i }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /status unavailable/i })).toBeTruthy(),
  );
  expect(refresh).not.toHaveBeenCalled();
});
