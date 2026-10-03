// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  return { AgentLabel: real.AgentLabel, ModuleBar: real.ModuleBar };
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
  expect(state.invoke).toHaveBeenCalledWith('drishti', { scope: 'manual_trigger' });
  expect(screen.getByRole('link', { name: '#ledger-1' }).getAttribute('href')).toBe(
    '/ledger?q=ledger-1',
  );
});

it('leaves an ambiguous invocation unconfirmed without proof', async () => {
  state.invoke.mockRejectedValue(new Error('network interrupted'));
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
  expect(screen.getByTestId('related-agents').textContent).toContain('Discovery');
  expect(labels()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /Run it/ }));
  await waitFor(() =>
    expect(labels().map((l) => l.getAttribute('data-state'))).toEqual(['working', 'idle']),
  );
  finish({ latency_ms: 1, ledger_entry_ids: [] });
  await waitFor(() => expect(labels()).toHaveLength(0));
});
