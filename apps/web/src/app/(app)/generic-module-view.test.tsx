// @vitest-environment jsdom
import React from 'react';
import { AgentInvocationError } from '@/lib/invoke-agent';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GenericModuleView, type GenericModuleMeta } from './generic-module-view';

const state = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: state.refresh }) }));
vi.mock('@/lib/invoke-agent', () => ({
  invokeAgent: state.invoke,
  AgentInvocationError: class AgentInvocationError extends Error {},
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@axiom/ui', async () => {
  const real = await vi.importActual<typeof import('@axiom/ui')>('@axiom/ui');
  return {
    AgentLabel: real.AgentLabel,
    ModuleBar: real.ModuleBar,
    DataPlaceholder: real.DataPlaceholder,
    PageHeader: real.PageHeader,
  };
});
const meta: GenericModuleMeta = {
  moduleKey: 'discovery',
  title: 'Recorded module',
  hi: 'मॉड्यूल',
  phase: 'P1',
  autonomy: 'read-only',
  moduleId: 'M1',
  desc: 'Source-bound records',
  actionLabel: 'Open saved assessment',
  actionHref: '/assessment',
  cards: [{ h: 'Illustrative metric', rows: [{ t: 'Invented rows', v: '12.4M', dot: '#000' }] }],
};
beforeEach(() => {
  state.invoke.mockReset();
  state.refresh.mockReset();
});
afterEach(cleanup);

it('hides illustrative metrics for a real tenant and makes no unverified health or region claim', () => {
  render(<GenericModuleView meta={meta} />);
  expect(screen.getByTestId('module-bar').textContent).toContain('Discover & Classify');
  expect(screen.getByRole('link', { name: /Open saved assessment/ }).getAttribute('href')).toBe(
    '/assessment',
  );
  expect(document.body.textContent).toContain('Nothing measured yet');
  expect(document.body.textContent).not.toContain('12.4M');
  expect(document.body.textContent).not.toContain('Live Compliance Telemetry');
  expect(document.body.textContent).not.toContain('All client data resides strictly');
});

it('labels illustrative cards only for a demo tenant', () => {
  render(<GenericModuleView meta={meta} isDemo />);
  expect(document.body.textContent).toContain('Sample data.');
  expect(document.body.textContent).toContain('12.4M');
});

it('runs only the selected read-only agent and shows a returned ledger reference', async () => {
  state.invoke.mockResolvedValue({ latency_ms: 12, ledger_entry_ids: ['ledger-1'] });
  render(
    <GenericModuleView
      tenantId={'10000000-0000-4000-8000-000000000001'}
      canInvokeAgent
      meta={{
        ...meta,
        agent: 'Drishti',
        agentKey: 'drishti',
        actionLabel: 'Run discovery',
        actionHref: undefined,
        cards: [],
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Run discovery/ }));
  await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
  expect(state.invoke).toHaveBeenCalledWith('drishti', '10000000-0000-4000-8000-000000000001', {
    scope: 'manual_trigger',
  });
  expect(screen.getByRole('link', { name: '#ledger-1' }).getAttribute('href')).toBe(
    '/ledger?q=ledger-1',
  );
});

it('leaves an ambiguous invocation unconfirmed without proof', async () => {
  state.invoke.mockRejectedValue(new Error('network interrupted'));
  render(
    <GenericModuleView
      tenantId={'10000000-0000-4000-8000-000000000001'}
      canInvokeAgent
      meta={{
        ...meta,
        agentKey: 'drishti',
        actionLabel: 'Run discovery',
        actionHref: undefined,
        cards: [],
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Run discovery/ }));
  await waitFor(() =>
    expect(document.body.textContent).toContain('Could not confirm the agent outcome'),
  );
  expect(document.body.textContent).not.toContain('Task executed successfully');
  expect(document.body.textContent).not.toContain('Immutable ledger proof');
  expect(state.refresh).not.toHaveBeenCalled();
});

it('keeps related agents static and shows run state only while a run is in flight', async () => {
  let finish: (v: unknown) => void = () => {};
  state.invoke.mockReturnValue(new Promise((r) => (finish = r)));
  render(
    <GenericModuleView
      tenantId={'10000000-0000-4000-8000-000000000001'}
      canInvokeAgent
      meta={{
        ...meta,
        agent: 'Vibhaag + Drishti',
        agentKey: 'vibhaag',
        actionLabel: 'Run it',
        actionHref: undefined,
        cards: [],
      }}
    />,
  );
  const labels = () => screen.queryAllByTestId('agent-label');
  const relatedAgents = screen.getByTestId('related-agents');
  expect(within(relatedAgents).getByText('drishti', { exact: true })).toBeTruthy();
  expect(relatedAgents.textContent).not.toContain('Discovery');
  expect(relatedAgents.querySelector('svg')).toBeTruthy();
  expect(labels()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /Run it/ }));
  await waitFor(() =>
    // Only the agent actually invoked is shown, and only while it runs.
    expect(labels().map((l) => l.getAttribute('data-state'))).toEqual(['working']),
  );
  finish({ latency_ms: 1, ledger_entry_ids: [] });
  await waitFor(() => expect(labels()).toHaveLength(0));
});

it('keeps discovery readable without offering invocation to a viewer', () => {
  render(
    <GenericModuleView
      meta={{
        ...meta,
        agentKey: 'drishti',
        actionLabel: 'Run discovery',
        actionHref: undefined,
        cards: [],
      }}
    />,
  );
  expect(screen.getByTestId('module-bar')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Run discovery/ })).toBeNull();
});

it.each(['success', 'failure'])(
  'keeps a late %s from the original tenant out of the newly selected tenant',
  async (outcome) => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    state.invoke.mockReturnValue(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const invocationMeta = {
      ...meta,
      agentKey: 'drishti',
      actionHref: undefined,
      actionLabel: 'Run discovery',
      cards: [],
    };
    const view = render(
      <GenericModuleView
        meta={invocationMeta}
        canInvokeAgent
        tenantId="10000000-0000-4000-8000-000000000001"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Run discovery/ }));
    expect(state.invoke).toHaveBeenCalledWith('drishti', '10000000-0000-4000-8000-000000000001', {
      scope: 'manual_trigger',
    });
    view.rerender(
      <GenericModuleView
        meta={invocationMeta}
        canInvokeAgent
        tenantId="20000000-0000-4000-8000-000000000002"
      />,
    );
    expect(screen.queryByText('Invoking agent…')).toBeNull();
    await act(async () => {
      if (outcome === 'success') resolve({ latency_ms: 9, ledger_entry_ids: ['tenant-A-receipt'] });
      else reject(new Error('tenant-A-error'));
    });
    expect(document.body.textContent).not.toContain('tenant-A-receipt');
    expect(document.body.textContent).not.toContain('Could not confirm the agent outcome');
    expect(state.refresh).not.toHaveBeenCalled();
  },
);
it('never invokes an enabled generic agent without an explicit rendered tenant', () => {
  render(
    <GenericModuleView
      meta={{ ...meta, agentKey: 'drishti', actionHref: undefined, actionLabel: 'Run discovery' }}
      canInvokeAgent
    />,
  );
  const button = screen.getByRole('button', { name: /Run discovery/ });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(state.invoke).not.toHaveBeenCalled();
});
it('hides a completed generic result immediately when the rendered tenant changes', async () => {
  state.invoke.mockResolvedValue({ latency_ms: 9, ledger_entry_ids: ['tenant-A-receipt'] });
  const invocationMeta = {
    ...meta,
    agentKey: 'drishti',
    actionHref: undefined,
    actionLabel: 'Run discovery',
    cards: [],
  };
  const view = render(
    <GenericModuleView
      meta={invocationMeta}
      canInvokeAgent
      tenantId="10000000-0000-4000-8000-000000000001"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Run discovery/ }));
  await screen.findByRole('link', { name: '#tenant-A-receipt' });
  view.rerender(
    <GenericModuleView
      meta={invocationMeta}
      canInvokeAgent
      tenantId="20000000-0000-4000-8000-000000000002"
    />,
  );
  expect(screen.queryByRole('link', { name: '#tenant-A-receipt' })).toBeNull();
});

it.each(['success', 'failure'])('ignores a deferred generic %s after unmount', async (outcome) => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  state.invoke.mockReturnValue(
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
    <GenericModuleView
      tenantId="10000000-0000-4000-8000-000000000001"
      canInvokeAgent
      meta={{ ...meta, agentKey: 'drishti', actionHref: undefined, actionLabel: 'Run discovery' }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Run discovery/ }));
  view.unmount();
  await act(async () => {
    if (outcome === 'success') resolve(value);
    else reject(error);
  });
  expect(observed).not.toHaveBeenCalled();
  expect(state.refresh).not.toHaveBeenCalled();
  expect(state.invoke).toHaveBeenCalledOnce();
});
it('keeps a confirmed generic receipt when page refresh throws without issuing another request', async () => {
  state.invoke.mockResolvedValue({ latency_ms: 9, ledger_entry_ids: ['confirmed-receipt'] });
  state.refresh.mockImplementation(() => {
    throw new Error('private-refresh-error');
  });
  render(
    <GenericModuleView
      tenantId="10000000-0000-4000-8000-000000000001"
      canInvokeAgent
      meta={{ ...meta, agentKey: 'drishti', actionHref: undefined, actionLabel: 'Run discovery' }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Run discovery/ }));
  await screen.findByRole('link', { name: '#confirmed-receipt' });
  expect(document.body.textContent).toContain('Agent drishti completed.');
  expect(document.body.textContent).not.toContain('Could not confirm the agent outcome.');
  expect(document.body.textContent).not.toContain('private-refresh-error');
  expect(state.invoke).toHaveBeenCalledOnce();
});
