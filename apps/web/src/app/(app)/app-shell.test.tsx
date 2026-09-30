// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';

const state = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), switchTenant: vi.fn(), pathname: '/dashboard' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push, refresh: state.refresh }), usePathname: () => state.pathname, useSearchParams: () => new URLSearchParams() }));
vi.mock('./tenant-actions', () => ({ switchTenantAction: state.switchTenant }));
vi.mock('./sidebar-agent-panel', () => ({ SidebarAgentPanel: () => null }));

const tenants = [
  { id: 'tenant-alpha', name: 'Alpha Org', slug: 'alpha', role: 'viewer' },
  { id: 'tenant-beta', name: 'Beta Org', slug: 'beta', role: 'owner' },
];
const props = { children: <main>Tenant content</main>, user: { id: 'user-1', email: 'reader@example.invalid' }, tenants, activeTenantSlug: 'alpha', capabilities: [] as string[], logoutAction: async () => {} };

beforeEach(() => {
  state.push.mockReset(); state.refresh.mockReset(); state.switchTenant.mockReset();
  state.pathname = '/dashboard';
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
  let engaged = false;
  const fetcher = vi.fn((url: string, _init?: RequestInit) => {
    if (url.includes('kill-switch/engage')) engaged = true;
    return Promise.resolve(Response.json(url.includes('kill-switch/status') ? { engaged } : url.includes('monitoring/alerts') ? { data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } } : { engaged }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<AppShell {...props} capabilities={['kill_switch.engage.tenant']} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/bff/v1/kill-switch/status', expect.anything()));
  fireEvent.click(screen.getByRole('button', { name: /Kill switch/i }));
  await waitFor(() => expect(screen.getByText(/KILL SWITCH ENGAGED/)).toBeTruthy());
  const mutation = fetcher.mock.calls.find(([url]) => url === '/api/bff/v1/kill-switch/engage');
  expect(mutation?.[1]).toMatchObject({ method: 'POST', headers: { 'X-Tenant-Id': 'tenant-alpha' } });
});

it('signals high-severity unread alerts with the risk color rather than proof gold', async () => {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(Response.json(url.includes('kill-switch') ? { engaged: false } : { data: { summary: { unread: 2, critical: 0, high: 1 }, alerts: [{ id: 'alert-high', title: 'Recorded high risk', summary: 'Review required', severity: 'high', status: 'unread', alert_type: 'drift', created_at: '2026-10-01T00:00:00Z' }] } }))));
  render(<AppShell {...props} />);
  const alertsButton = screen.getByRole('button', { name: 'Continuous monitoring alerts' });
  await waitFor(() => expect(alertsButton.textContent).toContain('2'));
  expect([...alertsButton.querySelectorAll('span')].some((span) => span.className.includes('bg-[#D9534F]'))).toBe(true);
  fireEvent.click(alertsButton);
  const badge = screen.getByText('high');
  expect(badge.className).toContain('bg-[#D9534F]');
  expect(badge.className).not.toContain('#C9A227');
});

it('refuses kill-switch mutation when live status is unreadable', async () => {
  const fetcher = vi.fn((url: string) => Promise.resolve(url.includes('kill-switch/status')
    ? new Response(null, { status: 503 })
    : Response.json({ data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } })));
  vi.stubGlobal('fetch', fetcher);
  render(<AppShell {...props} capabilities={['kill_switch.engage.tenant']} />);
  const control = screen.getByRole('button', { name: /Kill switch status unavailable/i });
  expect(control.hasAttribute('disabled')).toBe(true);
  fireEvent.click(control);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/bff/v1/kill-switch/status', expect.anything()));
  expect(fetcher.mock.calls.some(([url]) => url === '/api/bff/v1/kill-switch/engage')).toBe(false);
});

it('does not claim there are no alerts when the tenant alert source fails', async () => {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(url.includes('monitoring/alerts')
    ? Response.json({ data: { summary: { unread: 0 }, alerts: [] } })
    : Response.json({ engaged: false }))));
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Continuous monitoring alerts' }));
  await waitFor(() => expect(screen.getByText('Alert status is unavailable.')).toBeTruthy());
  expect(document.body.textContent).not.toContain('No alerts in this loaded page.');
});

it('refuses a malformed alert row rather than showing a false empty or crashing the tray', async () => {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(Response.json(url.includes('kill-switch')
    ? { engaged: false }
    : { data: { summary: { unread: 1, critical: 1, high: 0 }, alerts: [null] } }))));
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Continuous monitoring alerts' }));
  await waitFor(() => expect(screen.getByText('Alert status is unavailable.')).toBeTruthy());
  expect(document.body.textContent).not.toContain('No alerts in this loaded page.');
});

it('rechecks tenant kill status instead of trusting an unscoped browser event', async () => {
  const fetcher = vi.fn((url: string) => Promise.resolve(Response.json(url.includes('kill-switch/status')
    ? { engaged: false }
    : { data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } })));
  vi.stubGlobal('fetch', fetcher);
  render(<AppShell {...props} capabilities={['kill_switch.engage.tenant']} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /^⏻ Kill switch$/ }).hasAttribute('disabled')).toBe(false));
  window.dispatchEvent(new CustomEvent('axiom:kill-switch-changed', { detail: { engaged: true } }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === '/api/bff/v1/kill-switch/status').length).toBe(2));
  expect(document.body.textContent).not.toContain('KILL SWITCH ENGAGED');
});

it('retracts a previously clear alert summary when its next poll fails', async () => {
  let poll: (() => void) | null = null;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  vi.stubGlobal('setInterval', vi.fn((handler: () => void, interval: number) => {
    if (interval === 30_000) { poll = handler; return 1; }
    return realSetInterval(handler, interval);
  }));
  vi.stubGlobal('clearInterval', vi.fn((id: number) => { if (id !== 1) realClearInterval(id); }));
  let alertReads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('monitoring/alerts')) {
      alertReads++;
      return Promise.resolve(alertReads === 1
        ? Response.json({ data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } })
        : new Response(null, { status: 503 }));
    }
    return Promise.resolve(Response.json({ engaged: false }));
  }));
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Continuous monitoring alerts' }));
  await waitFor(() => expect(screen.getByText('No alerts in this loaded page.')).toBeTruthy());
  expect(poll).not.toBeNull();
  await act(async () => { poll?.(); });
  await waitFor(() => expect(screen.getByText('Alert status is unavailable.')).toBeTruthy());
  expect(document.body.textContent).not.toContain('No alerts in this loaded page.');
});

it('keeps the kill switch engaged when the BFF refuses release', async () => {
  const fetcher = vi.fn((url: string, _init?: RequestInit) => Promise.resolve(url.includes('kill-switch/status')
    ? Response.json({ engaged: true })
    : url.includes('kill-switch/release')
      ? Response.json({ error: { code: 'denied' } }, { status: 403 })
      : Response.json({ data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } })));
  vi.stubGlobal('fetch', fetcher);
  render(<AppShell {...props} capabilities={['kill_switch.engage.tenant']} />);
  await waitFor(() => expect(screen.getByText(/KILL SWITCH ENGAGED/)).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Disengage' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/bff/v1/kill-switch/release')).toBe(true));
  expect(screen.getByText(/KILL SWITCH ENGAGED/)).toBeTruthy();
  const release = fetcher.mock.calls.find(([url]) => url === '/api/bff/v1/kill-switch/release');
  expect(release?.[1]).toMatchObject({ method: 'POST', headers: { 'X-Tenant-Id': 'tenant-alpha' } });
});

it('refreshes the dashboard after a verified tenant switch', async () => {
  state.switchTenant.mockResolvedValue({ ok: true });
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
  fireEvent.click(screen.getByRole('button', { name: /Beta Org/ }));
  await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
  expect(state.push).not.toHaveBeenCalled();
});

it('routes the portal to the verified selected tenant', async () => {
  state.switchTenant.mockResolvedValue({ ok: true });
  state.pathname = '/portal';
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
  fireEvent.click(screen.getByRole('button', { name: /Beta Org/ }));
  await waitFor(() => expect(state.switchTenant).toHaveBeenCalledWith('beta'));
  expect(state.refresh).not.toHaveBeenCalled();
  await waitFor(() => expect(state.push).toHaveBeenCalledWith('/portal?tenant=beta'));
});

it('shows only returned active alerts with their recorded severity and title', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.includes('kill-switch')
          ? Response.json({ engaged: false })
          : Response.json({
              data: {
                summary: { unread: 1, critical: 1, high: 0 },
                alerts: [
                  {
                    id: 'alert-1',
                    title: 'Recorded critical alert',
                    summary: 'Evidence-backed drift',
                    severity: 'critical',
                    status: 'unread',
                    alert_type: 'drift',
                    created_at: '2026-10-01T00:00:00Z',
                  },
                ],
              },
            }),
      ),
    ),
  );
  render(<AppShell {...props} />);
  const button = screen.getByRole('button', { name: 'Continuous monitoring alerts' });
  await waitFor(() => expect(button.textContent).toContain('1'));
  fireEvent.click(button);
  expect(screen.getByText('Recorded critical alert')).toBeTruthy();
  expect(screen.getByText('Evidence-backed drift')).toBeTruthy();
  expect(document.body.textContent).not.toContain('No alerts in this loaded page.');
});
