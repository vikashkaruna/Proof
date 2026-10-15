// @vitest-environment jsdom
import React from 'react';
import { AgentInvocationError } from '@/lib/invoke-agent';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ALL_AGENTS, SidebarAgentPanel } from './sidebar-agent-panel';
import { capabilitiesFor, Capability, UserRole } from '@axiom/types';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/invoke-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoke-agent')>()),
  invokeAgent: mocks.invoke,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.invoke.mockReset();
  mocks.refresh.mockReset();
});

it('does not offer a fictional regulatory feed scan or an enforcement countdown', async () => {
  const nazar = ALL_AGENTS.find((agent) => agent.name === 'nazar');
  expect(nazar?.description).toContain('unavailable');
  expect(nazar?.statutoryBoundary).not.toContain('13 May 2027');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [] })));
  render(<SidebarAgentPanel tenantId="10000000-0000-4000-8000-000000000001" />);
  await waitFor(() => expect(screen.getByText('No active agent runs reported')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /nazar/i }));
  expect(screen.getByRole('link', { name: /Open Regulatory Watch/ }).getAttribute('href')).toBe(
    '/regwatch',
  );
  expect(screen.queryByRole('button', { name: /Scan Regulatory Feeds/ })).toBeNull();
});

it('routes source-bound and approval-gated agents to dedicated workflows', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ active_runs: [] }));
  vi.stubGlobal('fetch', fetcher);
  render(<SidebarAgentPanel tenantId="10000000-0000-4000-8000-000000000001" />);
  await waitFor(() => expect(screen.getByText('No active agent runs reported')).toBeTruthy());
  for (const [name, path] of [
    ['drishti', '/discovery'],
    ['vibhaag', '/classification'],
    ['parikshan', '/assessment'],
    ['saakshi', '/evidence'],
    ['karya', '/approval'],
    ['prativedan', '/reports'],
    ['sanket', '/breaches'],
    ['samadhan', '/execution'],
    ['pramaan', '/reports'],
  ] as const) {
    const label = ALL_AGENTS.find((agent) => agent.name === name)?.actionLabel;
    if (!label) throw new Error(`Missing agent fixture ${name}`);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(name, 'i') }));
    expect(screen.getByRole('link', { name: new RegExp(label) }).getAttribute('href')).toBe(path);
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it.each([UserRole.FOUNDER, UserRole.OWNER, UserRole.VIEWER])(
  'offers recorded activity without sending an invalid discovery/classification run for %s',
  async (role) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ active_runs: [] }));
    vi.stubGlobal('fetch', fetcher);
    render(
      <SidebarAgentPanel
        tenantId={'10000000-0000-4000-8000-000000000001'}
        capabilities={capabilitiesFor(role)}
      />,
    );
    await waitFor(() => expect(screen.getByText('No active agent runs reported')).toBeTruthy());
    for (const [name, label, path, prerequisite] of [
      ['drishti', 'Open public website discovery', '/discovery', 'saved public HTML check'],
      [
        'vibhaag',
        'Open public website classification',
        '/classification',
        'retained Drishti observation',
      ],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(name, 'i') }));
      expect(screen.getByRole('link', { name: new RegExp(label) }).getAttribute('href')).toBe(path);
      expect(document.body.textContent).toContain(prerequisite);
      expect(document.body.textContent).toContain('retained source facts');
      expect(screen.queryByRole('button', { name: /Run Discovery|Run Classification/ })).toBeNull();
      if (role === UserRole.FOUNDER) {
        expect(screen.getByRole('link', { name: /Workbench/ }).getAttribute('href')).toBe(
          `/workbench?agent=${name}`,
        );
      } else {
        expect(screen.queryByRole('link', { name: /Workbench/ })).toBeNull();
      }
    }
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(
      fetcher.mock.calls.every(
        ([url, init]) => url === '/api/bff/v1/agents/runs/active' && !init?.method,
      ),
    ).toBe(true);
  },
);

it.each([
  { capabilities: [] },
  { capabilities: [Capability.AGENT_INVOKE] },
  { capabilities: [Capability.WORKBENCH_ACCESS] },
])(
  'hides direct verification unless both invocation and workbench permissions exist (%j)',
  async ({ capabilities }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [] })));
    render(
      <SidebarAgentPanel
        tenantId={'10000000-0000-4000-8000-000000000001'}
        capabilities={capabilities}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /lekha/i }));
    expect(screen.queryByRole('button', { name: /Verify Ledger Chain/ })).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  },
);

it('marks unreadable agent-run status unavailable instead of claiming no active runs', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  render(<SidebarAgentPanel tenantId="10000000-0000-4000-8000-000000000001" />);
  await waitFor(() => expect(screen.getByText('Agent-run status unavailable')).toBeTruthy());
  expect(document.body.textContent).not.toContain('No active agent runs reported');
  fireEvent.click(screen.getByRole('button', { name: /drishti/i }));
  expect(document.body.textContent).toContain('State: unavailable');
});

it('accepts active state only from a well-formed run list', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(Response.json({ active_runs: [{ agent: 'drishti', status: 'running' }] })),
  );
  const view = render(<SidebarAgentPanel tenantId="10000000-0000-4000-8000-000000000001" />);
  await waitFor(() => expect(screen.getByText('1 agent run(s) reported active')).toBeTruthy());
  expect(screen.getByRole('button', { name: /drishti/i }).title).toContain('Status: working');
  view.unmount();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: null })));
  render(<SidebarAgentPanel tenantId="10000000-0000-4000-8000-000000000001" />);
  await waitFor(() => expect(screen.getByText('Agent-run status unavailable')).toBeTruthy());
});

it('counts recorded runs separately from distinct agent names', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        active_runs: [
          { agent: 'drishti', status: 'running' },
          { agent: 'drishti', status: 'queued' },
          { agent: 'vibhaag', status: 'running' },
        ],
      }),
    ),
  );
  render(<SidebarAgentPanel tenantId="10000000-0000-4000-8000-000000000001" />);
  await waitFor(() => expect(screen.getByText('3 agent run(s) reported active')).toBeTruthy());
  expect(screen.getByRole('button', { name: /drishti/i }).title).toContain('Status: working');
  expect(screen.getByRole('button', { name: /vibhaag/i }).title).toContain('Status: working');
  expect(screen.getByRole('button', { name: /parikshan/i }).title).toContain('Status: idle');
});

it('retracts a previously active run when the next status poll is unreadable', async () => {
  let poll: (() => void) | null = null;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  vi.stubGlobal(
    'setInterval',
    vi.fn((handler: () => void, interval: number) => {
      if (interval === 4000) {
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
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      reads++;
      return reads === 1
        ? Response.json({ active_runs: [{ agent: 'drishti', status: 'running' }] })
        : new Response(null, { status: 503 });
    }),
  );
  render(<SidebarAgentPanel tenantId="10000000-0000-4000-8000-000000000001" />);
  await waitFor(() => expect(screen.getByText('1 agent run(s) reported active')).toBeTruthy());
  expect(poll).not.toBeNull();
  await act(async () => {
    poll?.();
  });
  await waitFor(() => expect(screen.getByText('Agent-run status unavailable')).toBeTruthy());
  expect(document.body.textContent).not.toContain('1 agent run(s) reported active');
  expect(screen.getByRole('button', { name: /drishti/i }).title).toContain('Status: unavailable');
});

it.each([
  { agent_name: 'drishti', status: 'running' },
  { agent: 'drishti', status: 'succeeded' },
])('refuses a nonempty response outside the persisted active-run contract (%j)', async (row) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [row] })));
  render(<SidebarAgentPanel tenantId="10000000-0000-4000-8000-000000000001" />);
  await waitFor(() => expect(screen.getByText('Agent-run status unavailable')).toBeTruthy());
});

it('shows ledger proof only after a confirmed direct invocation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [] })));
  mocks.invoke.mockResolvedValue({ latency_ms: 21, ledger_entry_ids: ['ledger-1', 'ledger-2'] });
  render(
    <SidebarAgentPanel
      tenantId={'10000000-0000-4000-8000-000000000001'}
      capabilities={capabilitiesFor(UserRole.FOUNDER)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /lekha/i }));
  fireEvent.click(screen.getByRole('button', { name: /Verify Ledger Chain/ }));
  await waitFor(() => expect(screen.getByText('✓ Succeeded')).toBeTruthy());
  expect(mocks.invoke).toHaveBeenCalledWith('lekha', '10000000-0000-4000-8000-000000000001', {
    scope: 'manual_trigger',
  });
  expect(screen.getByRole('link', { name: /#ledger-1, #ledger-2/ }).getAttribute('href')).toBe(
    '/ledger?q=ledger-1',
  );
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it('keeps an ambiguous direct invocation as an error without invented proof', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [] })));
  mocks.invoke.mockRejectedValue(new Error('private transport detail'));
  render(
    <SidebarAgentPanel
      tenantId={'10000000-0000-4000-8000-000000000001'}
      capabilities={capabilitiesFor(UserRole.FOUNDER)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /lekha/i }));
  fireEvent.click(screen.getByRole('button', { name: /Verify Ledger Chain/ }));
  await waitFor(() => expect(screen.getByText('✕ Error')).toBeTruthy());
  expect(document.body.textContent).toContain('Could not confirm the agent outcome.');
  expect(document.body.textContent).not.toContain('private transport detail');
  expect(document.body.textContent).not.toContain('Ledger proof:');
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it('draws every agent in its on-dark accent in the indigo sidebar, so Parikshan stays visible', () => {
  render(<SidebarAgentPanel tenantId="10000000-0000-4000-8000-000000000001" transparent />);
  const icon = screen.getByRole('button', { name: /parikshan/i }).querySelector('svg')!;
  // Parikshan's base accent is the sidebar's own indigo (#1E2A4A).
  expect(icon.style.color).toBe('rgb(129, 140, 248)');
  expect(icon.style.color).not.toBe('rgb(30, 42, 74)');
});

it.each(['success', 'failure'])(
  'suppresses a late direct-agent %s in another tenant',
  async (outcome) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [] })));
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    mocks.invoke.mockReturnValue(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const capabilities = capabilitiesFor(UserRole.FOUNDER);
    const view = render(
      <SidebarAgentPanel
        capabilities={capabilities}
        tenantId="10000000-0000-4000-8000-000000000001"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /lekha/i }));
    fireEvent.click(screen.getByRole('button', { name: /Verify Ledger Chain/ }));
    expect(mocks.invoke).toHaveBeenCalledWith('lekha', '10000000-0000-4000-8000-000000000001', {
      scope: 'manual_trigger',
    });
    view.rerender(
      <SidebarAgentPanel
        capabilities={capabilities}
        tenantId="20000000-0000-4000-8000-000000000002"
      />,
    );
    await act(async () => {
      if (outcome === 'success') resolve({ latency_ms: 9, ledger_entry_ids: ['tenant-A-receipt'] });
      else reject(new Error('tenant-A-error'));
    });
    expect(screen.queryByText('✓ Succeeded')).toBeNull();
    expect(screen.queryByText('✕ Error')).toBeNull();
    expect(document.body.textContent).not.toContain('tenant-A-receipt');
    expect(mocks.refresh).not.toHaveBeenCalled();
  },
);
it('does not invoke a direct sidebar agent without a rendered tenant', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [] })));
  render(<SidebarAgentPanel capabilities={capabilitiesFor(UserRole.FOUNDER)} />);
  fireEvent.click(screen.getByRole('button', { name: /lekha/i }));
  const button = screen.getByRole('button', { name: /Verify Ledger Chain/ });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it.each([undefined, '', 'invalid-tenant'])(
  'never polls or invokes without valid tenant scope %s',
  async (tenantId) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(
      <SidebarAgentPanel tenantId={tenantId} capabilities={capabilitiesFor(UserRole.FOUNDER)} />,
    );
    await screen.findByText('Agent-run status unavailable');
    fireEvent.click(screen.getByRole('button', { name: /lekha/i }));
    const button = screen.getByRole('button', { name: /Verify Ledger Chain/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  },
);
it('scopes polls explicitly and discards a late old-tenant activity response', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((yes) => {
          resolve = yes;
        }),
    )
    .mockResolvedValueOnce(Response.json({ active_runs: [] }));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<SidebarAgentPanel tenantId="10000000-0000-4000-8000-000000000001" />);
  expect(fetcher.mock.calls[0]![1].headers).toEqual({
    'X-Tenant-Id': '10000000-0000-4000-8000-000000000001',
  });
  view.rerender(<SidebarAgentPanel tenantId="20000000-0000-4000-8000-000000000002" />);
  await screen.findByText('No active agent runs reported');
  expect(fetcher.mock.calls[1]![1].headers).toEqual({
    'X-Tenant-Id': '20000000-0000-4000-8000-000000000002',
  });
  await act(async () =>
    resolve(Response.json({ active_runs: [{ agent: 'lekha', status: 'running' }] })),
  );
  expect(screen.getByText('No active agent runs reported')).toBeTruthy();
  expect(screen.queryByText('1 agent run(s) reported active')).toBeNull();
});

it.each(['success', 'failure'])(
  'ignores a deferred direct-agent %s after unmount',
  async (outcome) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [] })));
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    mocks.invoke.mockReturnValue(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const observed = vi.fn(() => 9);
    const error = new AgentInvocationError('original-tenant');
    Object.defineProperty(error, 'message', { get: observed });
    const value = {
      get latency_ms() {
        return observed();
      },
      ledger_entry_ids: ['old-receipt'],
    };
    const view = render(
      <SidebarAgentPanel
        tenantId="10000000-0000-4000-8000-000000000001"
        capabilities={capabilitiesFor(UserRole.FOUNDER)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /lekha/i }));
    fireEvent.click(screen.getByRole('button', { name: /Verify Ledger Chain/ }));
    view.unmount();
    await act(async () => {
      if (outcome === 'success') resolve(value);
      else reject(error);
    });
    expect(observed).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledOnce();
  },
);
it('keeps a confirmed direct-agent receipt when page refresh throws without another invocation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [] })));
  mocks.invoke.mockResolvedValue({ latency_ms: 9, ledger_entry_ids: ['confirmed-receipt'] });
  mocks.refresh.mockImplementation(() => {
    throw new Error('private-refresh-error');
  });
  render(
    <SidebarAgentPanel
      tenantId="10000000-0000-4000-8000-000000000001"
      capabilities={capabilitiesFor(UserRole.FOUNDER)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /lekha/i }));
  fireEvent.click(screen.getByRole('button', { name: /Verify Ledger Chain/ }));
  await screen.findByRole('link', { name: '#confirmed-receipt' });
  expect(screen.getByText('✓ Succeeded')).toBeTruthy();
  expect(document.body.textContent).not.toContain('private-refresh-error');
  expect(mocks.invoke).toHaveBeenCalledOnce();
});
