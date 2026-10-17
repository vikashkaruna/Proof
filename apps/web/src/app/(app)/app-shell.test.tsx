// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';
import { APP_NAV_GROUPS, visibleRoutes } from './nav';
import DashboardPage from './dashboard/page';
import ApprovalPage from './approval/page';
import PlansPage from './plans/page';
import RegWatchPage from './regwatch/page';
import { DpbReviewsClient } from './breaches/dpb-reviews/reviews-client';
import { TechnicalReviewsClient } from './execution/technical-reviews/reviews-client';

const state = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  switchTenant: vi.fn(),
  pathname: '/dashboard',
  search: '',
  panelCapabilities: [] as readonly string[],
  panelTenantId: null as string | null,
  linkOptions: [] as { href: string; prefetch: boolean | 'auto' | null | undefined }[],
}));
vi.mock('next/link', async () => {
  const { default: Link } = await vi.importActual<typeof import('next/link')>('next/link');
  return {
    default: (props: React.ComponentProps<typeof Link>) => {
      state.linkOptions.push({ href: String(props.href), prefetch: props.prefetch });
      return <Link {...props} />;
    },
  };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: state.push, refresh: state.refresh }),
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock('./tenant-actions', () => ({ switchTenantAction: state.switchTenant }));
vi.mock('@/lib/tenant-context', () => {
  const context = {
    tenantId: 'tenant-alpha',
    tenantName: 'Alpha Org',
    role: 'approver',
    approvalScopes: [] as string[],
    supabase: {
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          order: () => query,
          limit: () => query,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: [], count: 0, error: null }).then(resolve),
        };
        return query;
      },
    },
  };
  return {
    Capability: { PLAN_READ: 'plan.read' },
    requireTenantContext: async () => context,
    requireCapabilityContext: async () => context,
  };
});
vi.mock('./sidebar-agent-panel', () => ({
  SidebarAgentPanel: ({
    capabilities,
    tenantId,
  }: {
    capabilities: readonly string[];
    tenantId: string | null;
  }) => {
    state.panelTenantId = tenantId;
    state.panelCapabilities = capabilities;
    return null;
  },
}));

const tenants = [
  { id: 'tenant-alpha', name: 'Alpha Org', slug: 'alpha', role: 'viewer' },
  { id: 'tenant-beta', name: 'Beta Org', slug: 'beta', role: 'owner' },
];
const props = {
  children: <section>Tenant content</section>,
  user: { id: 'user-1', email: 'reader@example.invalid' },
  tenants,
  activeTenantSlug: 'alpha',
  capabilities: [] as string[],
  logoutAction: async () => {},
};

beforeEach(() => {
  state.push.mockReset();
  state.refresh.mockReset();
  state.switchTenant.mockReset();
  state.pathname = '/dashboard';
  state.search = '';
  state.panelCapabilities = [];
  state.linkOptions = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        Response.json(
          url.includes('kill-switch')
            ? { engaged: false }
            : url.includes('/reports/')
              ? { requests: [], total: 0 }
              : { data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } },
        ),
      ),
    ),
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
  // jsdom does not implement dialog.close; the shell calls it after navigation.
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows a viewer only verified memberships and no mutating kill-switch authority', async () => {
  render(<AppShell {...props} />);
  expect(screen.queryByRole('button', { name: /Kill switch/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
  expect(screen.getByText('Your organizations')).toBeTruthy();
  expect(screen.getAllByText('Beta Org').length).toBeGreaterThan(0);
  expect(document.body.textContent).not.toContain('Meridian Pay');
  expect(screen.getByText('Tenant content')).toBeTruthy();
  expect(state.panelCapabilities).toEqual(props.capabilities);
});

it('passes the active tenant capabilities to agent controls', () => {
  const capabilities = ['agent.invoke', 'workbench.access'];
  render(<AppShell {...props} capabilities={capabilities} />);
  expect(state.panelCapabilities).toEqual(capabilities);
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
  let resolveStatus!: (response: Response) => void;
  const initialStatus = new Promise<Response>((resolve) => {
    resolveStatus = resolve;
  });
  let statusRequests = 0;
  const fetcher = vi.fn((url: string, _init?: RequestInit) => {
    if (url.includes('kill-switch/status') && statusRequests++ === 0) return initialStatus;
    if (url.includes('kill-switch/engage')) engaged = true;
    return Promise.resolve(
      Response.json(
        url.includes('kill-switch/status')
          ? { engaged }
          : url.includes('monitoring/alerts')
            ? { data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } }
            : { engaged },
      ),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  render(<AppShell {...props} capabilities={['kill_switch.engage.tenant']} />);
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith('/api/bff/v1/kill-switch/status', expect.anything()),
  );
  const unavailable = screen.getByRole('button', { name: 'Kill switch status unavailable' });
  expect(unavailable.hasAttribute('disabled')).toBe(true);
  fireEvent.click(unavailable);
  expect(fetcher.mock.calls.some(([url]) => url === '/api/bff/v1/kill-switch/engage')).toBe(false);
  expect(globalThis.confirm).not.toHaveBeenCalled();

  // A dispatched status request is not yet an authoritative state. Wait for
  // its response and the rendered enabled control before exercising mutation.
  await act(async () => {
    resolveStatus(Response.json({ engaged: false }));
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Kill switch$/ }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: /^Kill switch$/ }));
  await waitFor(() => expect(screen.getByText(/KILL SWITCH ENGAGED/)).toBeTruthy());
  expect(globalThis.confirm).toHaveBeenCalledTimes(1);
  expect(globalThis.confirm).toHaveBeenCalledWith(
    expect.stringContaining('next enforced checkpoint'),
  );
  expect(screen.getByText(/Running work stops at its next enforced checkpoint/)).toBeTruthy();
  expect(
    fetcher.mock.calls.filter(([url]) => url === '/api/bff/v1/kill-switch/engage'),
  ).toHaveLength(1);
  const mutation = fetcher.mock.calls.find(([url]) => url === '/api/bff/v1/kill-switch/engage');
  expect(mutation?.[1]).toMatchObject({
    method: 'POST',
    headers: { 'X-Tenant-Id': 'tenant-alpha' },
  });
});

it('signals high-severity unread alerts with the risk color rather than proof gold', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        Response.json(
          url.includes('kill-switch')
            ? { engaged: false }
            : {
                data: {
                  summary: { unread: 2, critical: 0, high: 1 },
                  alerts: [
                    {
                      id: 'alert-high',
                      title: 'Recorded high risk',
                      summary: 'Review required',
                      severity: 'high',
                      status: 'unread',
                      alert_type: 'drift',
                      created_at: '2026-10-01T00:00:00Z',
                    },
                  ],
                },
              },
        ),
      ),
    ),
  );
  render(<AppShell {...props} />);
  const alertsButton = screen.getByRole('button', { name: 'Continuous monitoring alerts' });
  await waitFor(() => expect(alertsButton.textContent).toContain('2'));
  expect(
    [...alertsButton.querySelectorAll('span')].some((span) =>
      span.className.includes('bg-[#D9534F]'),
    ),
  ).toBe(true);
  fireEvent.click(alertsButton);
  const badge = screen.getByText('high');
  expect(badge.className).toContain('bg-[#D9534F]');
  expect(badge.className).not.toContain('#C9A227');
});

it('refuses kill-switch mutation when live status is unreadable', async () => {
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      url.includes('kill-switch/status')
        ? new Response(null, { status: 503 })
        : Response.json({ data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<AppShell {...props} capabilities={['kill_switch.engage.tenant']} />);
  const control = screen.getByRole('button', { name: /Kill switch status unavailable/i });
  expect(control.hasAttribute('disabled')).toBe(true);
  fireEvent.click(control);
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith('/api/bff/v1/kill-switch/status', expect.anything()),
  );
  expect(fetcher.mock.calls.some(([url]) => url === '/api/bff/v1/kill-switch/engage')).toBe(false);
});

it('does not claim there are no alerts when the tenant alert source fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.includes('monitoring/alerts')
          ? Response.json({ data: { summary: { unread: 0 }, alerts: [] } })
          : Response.json({ engaged: false }),
      ),
    ),
  );
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Continuous monitoring alerts' }));
  await waitFor(() => expect(screen.getByText('Alert status is unavailable.')).toBeTruthy());
  expect(document.body.textContent).not.toContain('No alerts in this loaded page.');
});

it('refuses a malformed alert row rather than showing a false empty or crashing the tray', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        Response.json(
          url.includes('kill-switch')
            ? { engaged: false }
            : { data: { summary: { unread: 1, critical: 1, high: 0 }, alerts: [null] } },
        ),
      ),
    ),
  );
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Continuous monitoring alerts' }));
  await waitFor(() => expect(screen.getByText('Alert status is unavailable.')).toBeTruthy());
  expect(document.body.textContent).not.toContain('No alerts in this loaded page.');
});

it('rechecks tenant kill status instead of trusting an unscoped browser event', async () => {
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      Response.json(
        url.includes('kill-switch/status')
          ? { engaged: false }
          : { data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } },
      ),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<AppShell {...props} capabilities={['kill_switch.engage.tenant']} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Kill switch$/ }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  window.dispatchEvent(new CustomEvent('axiom:kill-switch-changed', { detail: { engaged: true } }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.filter(([url]) => url === '/api/bff/v1/kill-switch/status').length,
    ).toBe(2),
  );
  expect(document.body.textContent).not.toContain('KILL SWITCH ENGAGED');
});

it('retracts a previously clear alert summary when its next poll fails', async () => {
  let poll: (() => void) | null = null;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  vi.stubGlobal(
    'setInterval',
    vi.fn((handler: () => void, interval: number) => {
      if (interval === 30_000) {
        poll = handler;
        return 1;
      }
      return realSetInterval(handler, interval);
    }),
  );
  vi.stubGlobal(
    'clearInterval',
    vi.fn((id: number) => {
      if (id !== 1) realClearInterval(id);
    }),
  );
  let alertReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('monitoring/alerts')) {
        alertReads++;
        return Promise.resolve(
          alertReads === 1
            ? Response.json({ data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } })
            : new Response(null, { status: 503 }),
        );
      }
      return Promise.resolve(Response.json({ engaged: false }));
    }),
  );
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Continuous monitoring alerts' }));
  await waitFor(() => expect(screen.getByText('No alerts in this loaded page.')).toBeTruthy());
  expect(poll).not.toBeNull();
  await act(async () => {
    poll?.();
  });
  await waitFor(() => expect(screen.getByText('Alert status is unavailable.')).toBeTruthy());
  expect(document.body.textContent).not.toContain('No alerts in this loaded page.');
});

it('keeps the kill switch engaged when the BFF refuses release', async () => {
  const fetcher = vi.fn((url: string, _init?: RequestInit) =>
    Promise.resolve(
      url.includes('kill-switch/status')
        ? Response.json({ engaged: true })
        : url.includes('kill-switch/release')
          ? Response.json({ error: { code: 'denied' } }, { status: 403 })
          : Response.json({ data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <AppShell
      {...props}
      capabilities={['kill_switch.engage.tenant', 'kill_switch.release.tenant']}
    />,
  );
  await waitFor(() => expect(screen.getByText(/KILL SWITCH ENGAGED/)).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Disengage' }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === '/api/bff/v1/kill-switch/release')).toBe(
      true,
    ),
  );
  expect(screen.getByText(/KILL SWITCH ENGAGED/)).toBeTruthy();
  // A refused release says so instead of doing nothing.
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('HTTP 403'));
  const release = fetcher.mock.calls.find(([url]) => url === '/api/bff/v1/kill-switch/release');
  expect(release?.[1]).toMatchObject({
    method: 'POST',
    headers: { 'X-Tenant-Id': 'tenant-alpha' },
  });
});

it('offers no Disengage to a role that can engage but not release', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.includes('kill-switch/status')
          ? Response.json({ engaged: true })
          : Response.json({ data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } }),
      ),
    ),
  );
  render(<AppShell {...props} capabilities={['kill_switch.engage.tenant']} />);
  await waitFor(() => expect(screen.getByText(/KILL SWITCH ENGAGED/)).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Disengage' })).toBeNull();
  expect(
    screen.getByText('An authorized owner or founder can release this tenant stop.'),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: /Kill switch active/ }).hasAttribute('disabled')).toBe(
    true,
  );
});

it('does not claim kill-switch engagement from an unconfirmed HTTP success', async () => {
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      url.includes('kill-switch/status')
        ? Response.json({ engaged: false })
        : url.includes('kill-switch/engage')
          ? Response.json({ accepted: true })
          : Response.json({ data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<AppShell {...props} capabilities={['kill_switch.engage.tenant']} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Kill switch$/ }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: /^Kill switch$/ }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === '/api/bff/v1/kill-switch/engage')).toBe(true),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Kill switch status unavailable/i })).toBeTruthy(),
  );
  expect(document.body.textContent).not.toContain('KILL SWITCH ENGAGED');
});

it('does not claim kill-switch release from an unconfirmed HTTP success', async () => {
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      url.includes('kill-switch/status')
        ? Response.json({ engaged: true })
        : url.includes('kill-switch/release')
          ? Response.json({ accepted: true })
          : Response.json({ data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <AppShell
      {...props}
      capabilities={['kill_switch.engage.tenant', 'kill_switch.release.tenant']}
    />,
  );
  await waitFor(() => expect(screen.getByText(/KILL SWITCH ENGAGED/)).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Disengage' }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === '/api/bff/v1/kill-switch/release')).toBe(
      true,
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Kill switch status unavailable/i })).toBeTruthy(),
  );
  expect(document.body.textContent).not.toContain('KILL SWITCH ENGAGED');
});

it('withholds further kill-switch action after an ambiguous network failure', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetcher = vi.fn((url: string) =>
    url.includes('kill-switch/engage')
      ? Promise.reject(new Error('connection lost'))
      : Promise.resolve(
          Response.json(
            url.includes('kill-switch/status')
              ? { engaged: false }
              : { data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } },
          ),
        ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<AppShell {...props} capabilities={['kill_switch.engage.tenant']} />);
  fireEvent.click(await screen.findByRole('button', { name: /^Kill switch$/ }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Kill switch status unavailable/i })).toBeTruthy(),
  );
  expect(error).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.filter(([url]) => url.includes('kill-switch/engage'))).toHaveLength(1);
  error.mockRestore();
});

it('shows a confirmed release and makes tenant mutations available again', async () => {
  let engaged = true;
  const fetcher = vi.fn((url: string) => {
    if (url.includes('kill-switch/release')) engaged = false;
    return Promise.resolve(
      Response.json(
        url.includes('monitoring/alerts')
          ? { data: { summary: { unread: 0, critical: 0, high: 0 }, alerts: [] } }
          : { engaged },
      ),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <AppShell
      {...props}
      capabilities={['kill_switch.engage.tenant', 'kill_switch.release.tenant']}
    />,
  );
  await waitFor(() => expect(screen.getByText(/KILL SWITCH ENGAGED/)).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Disengage' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Kill switch$/ }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  expect(document.body.textContent).not.toContain('KILL SWITCH ENGAGED');
});

it('refreshes the dashboard after a verified tenant switch', async () => {
  state.switchTenant.mockResolvedValue({ ok: true });
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
  fireEvent.click(screen.getByRole('button', { name: /Beta Org/ }));
  await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
  expect(state.push).not.toHaveBeenCalled();
});

it('refreshes the portal in place after a verified switch, with no tenant parameter', async () => {
  state.switchTenant.mockResolvedValue({ ok: true });
  state.pathname = '/portal';
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
  fireEvent.click(screen.getByRole('button', { name: /Beta Org/ }));
  await waitFor(() => expect(state.switchTenant).toHaveBeenCalledWith('beta'));
  await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
  expect(state.push).not.toHaveBeenCalled();
});

it('keeps mobile navigation keyboard focus inside its dialog', () => {
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
  const dialog = screen.getByRole('dialog', { name: 'Application navigation', hidden: true });
  expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
  expect(
    screen.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded'),
  ).toBe('true');
  const controls = dialog.querySelectorAll<HTMLElement>(
    'a[href], button:not(:disabled), [tabindex="0"]',
  );
  controls[0]!.focus();
  const reverse = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  dialog.dispatchEvent(reverse);
  expect(reverse.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(controls[controls.length - 1]);
  const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  dialog.dispatchEvent(forward);
  expect(forward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(controls[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Close navigation', hidden: true }));
  expect(HTMLDialogElement.prototype.close).toHaveBeenCalled();
});

it('loads protected shell destinations only on selection, including opened header trays', () => {
  const capabilities = [
    ...APP_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.capability)),
    'tenant.create',
  ];
  render(<AppShell {...props} capabilities={capabilities} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continuous monitoring alerts' }));
  const expected = visibleRoutes(capabilities);
  expect(expected.length).toBeGreaterThan(20);
  expect(new Set(state.linkOptions.map((link) => link.href))).toEqual(
    new Set([...expected, '/dashboard', '/onboarding', '/monitoring']),
  );
  // Verify the Next Link contract; actual production request counts are checked
  // in the browser, where Next aliases Link to its App Router implementation.
  expect(state.linkOptions.every((link) => link.prefetch === false)).toBe(true);
});

it('preserves module URLs, active state and the mobile navigation close action', () => {
  const capabilities = APP_NAV_GROUPS.flatMap((group) =>
    group.items.map((item) => item.capability),
  );
  state.pathname = '/reports';
  render(<AppShell {...props} capabilities={capabilities} />);
  const navigation = screen.getAllByRole('navigation', { name: 'Main navigation', hidden: true });
  for (const nav of navigation) {
    expect(
      within(nav)
        .getAllByRole('link', { hidden: true })
        .map((link) => link.getAttribute('href')),
    ).toEqual(visibleRoutes(capabilities));
    expect(
      within(nav)
        .getByRole('link', { name: /^Working Reports/, hidden: true })
        .getAttribute('aria-current'),
    ).toBe('page');
  }
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
  const dialog = screen.getByRole('dialog', { name: 'Application navigation', hidden: true });
  expect(dialog.hasAttribute('open')).toBe(true);
  const estate = within(dialog).getByRole('link', { name: /^Client Estate/, hidden: true });
  expect(estate.getAttribute('href')).toBe('/estate');
  // A modified click keeps real Next Link/native browser URL handling in this
  // unit environment while exercising the shell's actual drawer handler.
  estate.addEventListener('click', (event) => event.preventDefault(), { once: true });
  fireEvent.click(estate, { ctrlKey: true });
  expect(dialog.hasAttribute('open')).toBe(false);
});

it('does not request a tenant switch when the current membership is selected', async () => {
  render(<AppShell {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
  fireEvent.click(screen.getByRole('button', { name: /Alpha Org/ }));
  expect(state.switchTenant).not.toHaveBeenCalled();
  expect(state.push).not.toHaveBeenCalled();
  expect(state.refresh).not.toHaveBeenCalled();
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

it('does not read or mutate a fabricated tenant when membership is absent', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(
    <AppShell
      {...props}
      tenants={[]}
      activeTenantSlug="forged-cookie"
      capabilities={['kill_switch.engage.tenant', 'report.read']}
    />,
  );
  expect(screen.getByRole('button', { name: 'Switch organization' }).textContent).toContain(
    'No organization',
  );
  expect(
    screen
      .getByRole('button', { name: /Kill switch status unavailable/i })
      .hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
  expect(screen.getByText('You are not a member of any organization yet.')).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});

it('scopes shell reads to a verified membership when a preferred slug is forged', async () => {
  const fetcher = vi.mocked(globalThis.fetch);
  render(<AppShell {...props} activeTenantSlug="forged-cookie" capabilities={['report.read']} />);
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      '/api/bff/v1/kill-switch/status',
      expect.objectContaining({ headers: { 'X-Tenant-Id': 'tenant-alpha' } }),
    ),
  );
  expect(screen.getByRole('button', { name: 'Switch organization' }).textContent).toContain(
    'Alpha Org',
  );
  expect(
    fetcher.mock.calls.every(
      ([, init]) => (init?.headers as Record<string, string>)?.['X-Tenant-Id'] === 'tenant-alpha',
    ),
  ).toBe(true);
});

it('marks only the selected report tab as the current navigation destination', () => {
  state.pathname = '/reports';
  state.search = 'tab=pramaan';
  render(<AppShell {...props} capabilities={['report.read']} canViewClosureDossiers />);
  const nav = screen.getAllByRole('navigation', { name: 'Main navigation', hidden: true })[0]!;
  expect(
    within(nav)
      .getByRole('link', { name: /Statutory Proof Dossiers/ })
      .getAttribute('aria-current'),
  ).toBe('page');
  expect(
    within(nav)
      .getByRole('link', { name: /Working Reports & Registers/ })
      .getAttribute('aria-current'),
  ).toBeNull();
});

it('keeps the working reports destination active for a reader who requests a hidden tab URL', () => {
  state.pathname = '/reports';
  state.search = 'tab=pramaan';
  render(<AppShell {...props} capabilities={['report.read']} />);
  const nav = screen.getAllByRole('navigation', { name: 'Main navigation', hidden: true })[0]!;
  expect(within(nav).queryByRole('link', { name: /Statutory Proof Dossiers/ })).toBeNull();
  expect(
    within(nav)
      .getByRole('link', { name: /Working Reports & Registers/ })
      .getAttribute('aria-current'),
  ).toBe('page');
  expect(document.querySelector('header')?.textContent).toContain('Working Reports & Registers');
});

it.each([
  ['/portal', 'Operate', 'Client Portal'],
  ['/onboarding', 'Overview', 'Enterprise Onboarding'],
])('shows the %s route context in the shell header', (path, breadcrumb, title) => {
  state.pathname = path;
  render(<AppShell {...props} />);
  const header = document.querySelector('header')!;
  expect(within(header).getByText(breadcrumb)).toBeTruthy();
  expect(within(header).getByText(title)).toBeTruthy();
  expect(within(header).queryByText('Dashboard')).toBeNull();
});

it.each(['/engagements', '/engagements/recorded-id'])(
  'selects Engagements navigation and title for %s',
  (path) => {
    state.pathname = path;
    render(<AppShell {...props} capabilities={['posture.read', 'assessment.run']} />);
    const nav = screen.getAllByRole('navigation', { name: 'Main navigation', hidden: true })[0]!;
    expect(
      within(nav)
        .getByRole('link', { name: /Engagements/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    const header = document.querySelector('header')!;
    expect(within(header).getByText('Assess')).toBeTruthy();
    expect(within(header).getByText('Engagements')).toBeTruthy();
  },
);

it.each([
  ['/dashboard', 'Dashboard', DashboardPage, 'Dashboard'],
  ['/plans', 'Remediation Plans', PlansPage, 'Remediation plans'],
  ['/approval', 'Approval Queue', ApprovalPage, 'Approval queue'],
  ['/regwatch', 'Regulatory Watch', RegWatchPage, null],
  [
    '/breaches/dpb-reviews',
    'DPB notification review packs',
    async () => (
      <DpbReviewsClient
        tenantId="tenant-alpha"
        breaches={[]}
        notifications={[]}
        canRequest={false}
        founder={false}
      />
    ),
    null,
  ],
  [
    '/execution/technical-reviews',
    'Recorded technical remediation registers',
    async () => (
      <TechnicalReviewsClient
        tenantId="tenant-alpha"
        plans={[]}
        canRequest={false}
        founder={false}
        canList={false}
      />
    ),
    null,
  ],
] as const)(
  'provides one primary content landmark for the actual %s page inside the shell',
  async (path, title, page, regionName) => {
    state.pathname = path;
    await act(async () => {
      render(<AppShell {...props}>{await page()}</AppShell>);
    });
    const landmarks = screen.getAllByRole('main');
    expect(landmarks).toHaveLength(1);
    expect(within(landmarks[0]!).getByRole('heading', { level: 1, name: title })).toBeTruthy();
    if (regionName) {
      expect(within(landmarks[0]!).getByRole('region', { name: regionName })).toBeTruthy();
    }
  },
);

it('offers "Onboard New Organization" only to a persona that may create a tenant', () => {
  render(<AppShell {...props} capabilities={['posture.read']} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
  expect(screen.queryByRole('link', { name: /Onboard New Organization/ })).toBeNull();
  cleanup();
  render(<AppShell {...props} capabilities={['posture.read', 'tenant.create']} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
  expect(screen.getByRole('link', { name: /Onboard New Organization/ })).toBeTruthy();
});

it('shows the agent launcher only to a persona that runs agents', () => {
  render(<AppShell {...props} capabilities={['posture.read', 'evidence.read']} />);
  expect(screen.queryAllByText('Agents')).toHaveLength(0);
  cleanup();
  render(<AppShell {...props} capabilities={['posture.read', 'agent.invoke']} />);
  expect(screen.getAllByText('Agents').length).toBeGreaterThan(0);
});

it('passes the rendered selected tenant to the sidebar rather than deriving it from a browser cookie', () => {
  render(<AppShell {...props} capabilities={['agent.invoke']} />);
  expect(state.panelTenantId).toBe('tenant-alpha');
});
