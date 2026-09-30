// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';

const state = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), switchTenant: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push, refresh: state.refresh }), usePathname: () => '/dashboard', useSearchParams: () => new URLSearchParams() }));
vi.mock('./tenant-actions', () => ({ switchTenantAction: state.switchTenant }));
vi.mock('./sidebar-agent-panel', () => ({ SidebarAgentPanel: () => null }));

const tenants = [
  { id: 'tenant-alpha', name: 'Alpha Org', slug: 'alpha', role: 'viewer' },
  { id: 'tenant-beta', name: 'Beta Org', slug: 'beta', role: 'owner' },
];
const props = { children: <main>Tenant content</main>, user: { id: 'user-1', email: 'reader@example.invalid' }, tenants, activeTenantSlug: 'alpha', capabilities: [] as string[], logoutAction: async () => {} };

beforeEach(() => {
  state.push.mockReset(); state.refresh.mockReset(); state.switchTenant.mockReset();
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(Response.json(url.includes('kill-switch') ? { engaged: false } : { data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } }))));
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('confirm', vi.fn(() => true));
  // jsdom does not implement dialog.close; the shell calls it after navigation.
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows a viewer only verified memberships and no mutating kill-switch authority', async () => {
  render(<AppShell {...props} />);
  expect(screen.queryByRole('button', { name: /Kill switch/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
  expect(screen.getByText('Your organizations')).toBeTruthy();
  expect(screen.getAllByText('Beta Org').length).toBeGreaterThan(0);
  expect(document.body.textContent).not.toContain('Meridian Pay');
  expect(screen.getByText('Tenant content')).toBeTruthy();
});

it('switches tenant only after the server action verifies membership', async () => {
  state.switchTenant.mockResolvedValue({ ok: false });
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
  fireEvent.click(screen.getByRole('button', { name: /Beta Org/ }));
  await waitFor(() => expect(state.switchTenant).toHaveBeenCalledWith('beta'));
  expect(state.refresh).not.toHaveBeenCalled();
  expect(state.push).not.toHaveBeenCalled();
});

it('requires a confirmed capability-bearing request to engage the kill switch', async () => {
  const fetcher = vi.fn((url: string, _init?: RequestInit) => Promise.resolve(Response.json(url.includes('kill-switch/status') ? { engaged: false } : url.includes('monitoring/alerts') ? { data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } } : { engaged: true })));
  vi.stubGlobal('fetch', fetcher);
  render(<AppShell {...props} capabilities={['kill_switch.engage.tenant']} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/bff/v1/kill-switch/status', expect.anything()));
  fireEvent.click(screen.getByRole('button', { name: /Kill switch/i }));
  await waitFor(() => expect(screen.getByText(/KILL SWITCH ENGAGED/)).toBeTruthy());
  const mutation = fetcher.mock.calls.find(([url]) => url === '/api/bff/v1/kill-switch/engage');
  expect(mutation?.[1]).toMatchObject({ method: 'POST', headers: { 'X-Tenant-Id': 'tenant-alpha' } });
});

it('signals high-severity unread alerts with the risk color rather than proof gold', async () => {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(Response.json(url.includes('kill-switch') ? { engaged: false } : { data: { summary: { unread: 2, critical: 0, high: 1 }, alerts: [] } }))));
  render(<AppShell {...props} />);
  const alertsButton = screen.getByRole('button', { name: 'Continuous monitoring alerts' });
  await waitFor(() => expect(alertsButton.textContent).toContain('2'));
  expect([...alertsButton.querySelectorAll('span')].some((span) => span.className.includes('bg-[#D9534F]'))).toBe(true);
});
